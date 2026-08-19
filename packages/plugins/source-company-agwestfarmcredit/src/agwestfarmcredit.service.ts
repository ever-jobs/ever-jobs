import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AgWest Farm Credit — Borrower-owned agricultural lending and crop insurance cooperative serving the Western U.S..
 *
 * AgWest Farm Credit is a borrower-owned financial cooperative that
 * provides loans, leases, crop insurance, and related financial
 * services to farmers, ranchers, agribusinesses, and rural communities
 * across the Western United States. Headquartered in Spokane,
 * Washington, it was formed in 2023 through the merger of Northwest
 * Farm Credit Services and Farm Credit West, and operates as part of
 * the federally chartered Farm Credit System. Its hiring spans lending
 * and insurance teams organized by state (Washington, Montana, and
 * California), along with accounting, controller, and learning and
 * research functions.
 *
 * Sector: Agricultural finance and insurance. HQ: Spokane, WA, USA.
 *
 * Highlights:
 *   - Part of the federally chartered Farm Credit System
 *     (borrower-owned cooperative)
 *   - Formed in 2023 by the merger of Northwest Farm Credit Services
 *     and Farm Credit West
 *   - Serves farmers, ranchers, and agribusinesses across multiple
 *     Western states
 *   - Offers agricultural lending, leasing, and crop insurance
 *     products
 *   - State-organized lending/insurance teams plus controllers and
 *     learning and research functions
 *
 * Source profile (Spec 211):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/agwestfarmcredit/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AgWest Farm Credit'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 16 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/agwestfarmcredit/jobs';

@SourcePlugin({
  site: Site.AGWESTFARMCREDIT,
  name: 'AgWest Farm Credit',
  category: 'company',
})
@Injectable()
export class AgwestfarmcreditService implements IScraper {
  private readonly logger = new Logger(AgwestfarmcreditService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AgWest Farm Credit: fetching ${url}`);

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
        const id = `agwestfarmcredit-${jobId}`;

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
            site: Site.AGWESTFARMCREDIT,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AgWest Farm Credit',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/agwestfarmcredit/jobs/${listing.id}`,
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

      this.logger.log(`AgWest Farm Credit: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AgWest Farm Credit scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
