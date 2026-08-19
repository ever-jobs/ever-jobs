import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Netradyne — AI-powered fleet safety and video telematics company best known for its Driveri vision platform.
 *
 * Netradyne is a technology company that builds AI-powered fleet
 * safety and video telematics products for commercial vehicle
 * operators. Its flagship Driveri platform uses edge computing and
 * computer vision to analyze drive time in real time, recognizing both
 * risky and positive driving behaviors to help reduce collisions and
 * coach drivers. The company serves fleets across industries in
 * markets including North America, Europe, Australia, New Zealand, and
 * India.
 *
 * Sector: Fleet Safety / Video Telematics (AI). HQ: San Diego, California, USA.
 *
 * Highlights:
 *   - Founded in 2015; headquartered in San Diego, California
 *   - Flagship product: Driveri AI dash-cam and fleet safety platform
 *   - Uses edge AI and computer vision to analyze full drive time
 *   - Operates globally with offices including Bangalore, India
 *   - Focused on commercial fleet collision reduction and driver
 *     coaching
 *
 * Source profile (Spec 750):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/netradyne/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Netradyne'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 70 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/netradyne/jobs';

@SourcePlugin({
  site: Site.NETRADYNE,
  name: 'Netradyne',
  category: 'company',
})
@Injectable()
export class NetradyneService implements IScraper {
  private readonly logger = new Logger(NetradyneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Netradyne: fetching ${url}`);

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
        const id = `netradyne-${jobId}`;

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
            site: Site.NETRADYNE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Netradyne',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/netradyne/jobs/${listing.id}`,
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

      this.logger.log(`Netradyne: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Netradyne scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
