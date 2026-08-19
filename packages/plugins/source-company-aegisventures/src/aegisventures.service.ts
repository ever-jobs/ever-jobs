import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aegis Ventures — Healthtech venture studio that co-builds AI-focused healthcare companies with health systems.
 *
 * Aegis Ventures is a venture studio that co-founds and scales
 * healthcare technology companies, partnering with health systems and
 * entrepreneurs to build AI-focused products for clinical and
 * operational use. Its shared careers board hosts roles spanning
 * finance, clinical operations, and client success, supporting both
 * the studio and its portfolio companies. Finance positions are based
 * in Eagan, Minnesota, while clinical and customer-facing roles are
 * listed as remote within the U.S.
 *
 * Sector: Healthcare technology (venture studio). HQ: New York, USA.
 *
 * Highlights:
 *   - Operates as a venture studio originating and scaling healthcare
 *     technology companies
 *   - Focus on artificial intelligence applied to clinical care and
 *     healthcare operations
 *   - Hiring across Finance, Clinical Operations, Client Success, and
 *     Business Operations functions
 *   - Finance roles based in Eagan, Minnesota; clinical and
 *     customer-success roles remote within the U.S.
 *   - Partners with health systems via a multi-system Digital
 *     Consortium to co-develop products
 *
 * Source profile (Spec 197):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aegisventures/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aegis Ventures'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 5 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aegisventures/jobs';

@SourcePlugin({
  site: Site.AEGISVENTURES,
  name: 'Aegis Ventures',
  category: 'company',
})
@Injectable()
export class AegisventuresService implements IScraper {
  private readonly logger = new Logger(AegisventuresService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aegis Ventures: fetching ${url}`);

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
        const id = `aegisventures-${jobId}`;

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
            site: Site.AEGISVENTURES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aegis Ventures',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aegisventures/jobs/${listing.id}`,
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

      this.logger.log(`Aegis Ventures: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aegis Ventures scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
