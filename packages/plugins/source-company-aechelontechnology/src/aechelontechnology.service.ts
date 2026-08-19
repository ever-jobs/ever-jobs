import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aechelon Technology — Real-time visual simulation image generators and geospecific databases for defense training and simulation.
 *
 * Aechelon Technology, Inc. is a defense and simulation technology
 * company founded in 1998 that develops real-time visual simulation
 * image generators along with geospecific visual, sensor, and radar
 * databases and 3D models, primarily for U.S. military and government
 * training and simulation programs. Its work spans out-the-window,
 * electro-optical, infrared, and radar visualization used in flight
 * simulators and synthetic training environments. The company is
 * headquartered in South San Francisco, CA, with an additional
 * engineering and operations presence in Orlando, FL. Hiring spans
 * systems engineering, data science and machine learning, and
 * geospecific 3D modeling and geospatial annotation functions.
 *
 * Sector: Defense & Simulation Technology. HQ: South San Francisco, CA, USA.
 *
 * Highlights:
 *   - Founded in 1998; builds real-time image generators and
 *     geospecific visual/sensor/radar databases for simulation
 *   - Serves U.S. military and government training programs (Air
 *     Force, Navy, Marine Corps, Army and others)
 *   - Headquartered in South San Francisco, CA, with an additional
 *     site in Orlando, FL
 *   - Open roles span systems integration engineering, data
 *     science/automation/ML, and geospecific 3D modeling and
 *     annotation
 *
 * Source profile (Spec 196):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aechelontechnology/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aechelon Technology'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 13 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aechelontechnology/jobs';

@SourcePlugin({
  site: Site.AECHELONTECHNOLOGY,
  name: 'Aechelon Technology',
  category: 'company',
})
@Injectable()
export class AechelontechnologyService implements IScraper {
  private readonly logger = new Logger(AechelontechnologyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aechelon Technology: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (listing.departments?.[0]?.name ?? '')
            .toLowerCase()
            .includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `aechelontechnology-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.AECHELONTECHNOLOGY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aechelon Technology',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aechelontechnology/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`Aechelon Technology: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aechelon Technology scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
