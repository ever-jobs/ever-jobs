import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Slingshot Aerospace — Space-tracking company providing AI-powered orbital intelligence, satellite tracking, and space situational awareness software..
 *
 * Slingshot Aerospace is a space technology company that builds
 * software and data products for space situational awareness,
 * satellite tracking, and orbital simulation. Its platform fuses
 * sensor data with AI and machine learning to detect, track, and
 * characterize objects in orbit, supporting collision avoidance and
 * threat assessment. The company serves national security, defense,
 * and commercial space operators. Its product suite spans space-domain
 * awareness, simulation/digital twins, and astrodynamics analytics.
 *
 * Sector: Space Tech / Defense / AI. HQ: El Segundo, California, USA.
 *
 * Highlights:
 *   - Develops AI-driven space situational awareness and
 *     satellite-tracking software
 *   - Serves national security, defense, and commercial space-operator
 *     customers
 *   - Offerings span orbital intelligence, collision avoidance, and
 *     space simulation/digital twins
 *   - Headquartered in El Segundo, California, with US-based and
 *     remote roles
 *   - Hiring across applied AI research and national-security business
 *     development
 *
 * Source profile (Spec 785):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/slingshotaerospace/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Slingshot Aerospace'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 35 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/slingshotaerospace/jobs';

@SourcePlugin({
  site: Site.SLINGSHOT_AEROSPACE,
  name: 'Slingshot Aerospace',
  category: 'company',
})
@Injectable()
export class SlingshotAerospaceService implements IScraper {
  private readonly logger = new Logger(SlingshotAerospaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Slingshot Aerospace: fetching ${url}`);

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
        const id = `slingshotaerospace-${jobId}`;

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
            site: Site.SLINGSHOT_AEROSPACE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Slingshot Aerospace',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/slingshotaerospace/jobs/${listing.id}`,
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

      this.logger.log(`Slingshot Aerospace: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Slingshot Aerospace scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
