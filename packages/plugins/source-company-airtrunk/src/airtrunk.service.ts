import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AirTrunk — Hyperscale data center operator serving cloud and enterprise customers across the Asia-Pacific region..
 *
 * AirTrunk is a data center operator that designs, builds, and runs
 * large-scale hyperscale data center facilities across the
 * Asia-Pacific region. The company supports cloud, content, and
 * enterprise customers with colocation capacity and related
 * infrastructure, and operates sites in markets including Australia,
 * Singapore, Japan, India, and Malaysia. Hiring across site selection,
 * development, infrastructure engineering, technology, and finance
 * functions reflects an organization focused on building and expanding
 * physical data center campuses.
 *
 * Sector: Data Centers / Digital Infrastructure. HQ: Sydney, Australia.
 *
 * Highlights:
 *   - Operates hyperscale data center facilities across multiple
 *     Asia-Pacific markets including Australia, Singapore, Japan,
 *     India, and Malaysia (Johor Bahru)
 *   - Maintains a regional headquarters presence in both North Sydney,
 *     Australia and Singapore
 *   - Hiring spans site selection, development, and high-voltage (HV)
 *     infrastructure roles tied to building and powering data center
 *     campuses
 *   - Recruits technology and analytics roles (e.g., Analytics
 *     Engineer) alongside finance and people operations functions
 *
 * Source profile (Spec 218):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/airtrunk/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AirTrunk'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 65 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/airtrunk/jobs';

@SourcePlugin({
  site: Site.AIRTRUNK,
  name: 'AirTrunk',
  category: 'company',
})
@Injectable()
export class AirtrunkService implements IScraper {
  private readonly logger = new Logger(AirtrunkService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AirTrunk: fetching ${url}`);

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
        const id = `airtrunk-${jobId}`;

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
            site: Site.AIRTRUNK,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AirTrunk',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/airtrunk/jobs/${listing.id}`,
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

      this.logger.log(`AirTrunk: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AirTrunk scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
