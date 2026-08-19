import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AfterShip — B2B SaaS platform for e-commerce post-purchase experience and shipment tracking.
 *
 * AfterShip is a B2B SaaS company founded in 2012 that builds software
 * for e-commerce merchants, centered on the post-purchase experience
 * such as shipment tracking, returns management, multi-carrier
 * shipping, and delivery notifications. It serves online retailers and
 * brands globally and operates a distributed workforce across multiple
 * regions. The company hires across functions including Product,
 * Sales, and Legal.
 *
 * Sector: E-commerce SaaS. HQ: Singapore.
 *
 * Highlights:
 *   - Founded in 2012
 *   - Focuses on e-commerce post-purchase tools: shipment tracking,
 *     returns, and multi-carrier shipping
 *   - Operates a distributed/global workforce with roles posted in
 *     Madrid (Spain), Vancouver, and Utah
 *   - Hiring spans Product, Sales, and Legal functions
 *   - Headquartered in Singapore with multiple international offices
 *
 * Source profile (Spec 203):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aftership/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AfterShip'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 24 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aftership/jobs';

@SourcePlugin({
  site: Site.AFTERSHIP,
  name: 'AfterShip',
  category: 'company',
})
@Injectable()
export class AftershipService implements IScraper {
  private readonly logger = new Logger(AftershipService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AfterShip: fetching ${url}`);

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
        const id = `aftership-${jobId}`;

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
            site: Site.AFTERSHIP,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AfterShip',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aftership/jobs/${listing.id}`,
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

      this.logger.log(`AfterShip: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AfterShip scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
