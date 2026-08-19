import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Zuora — Zuora provides cloud-based subscription management and quote-to-cash software that helps enterprises launch, bill, collect, and recognize revenue for recurring-revenue and consumption-based business models..
 *
 * Zuora, Inc. is an American enterprise software company headquartered
 * in Redwood City, California, that builds a quote-to-cash and
 * subscription-management platform automating recurring billing,
 * collections, quoting, revenue recognition, and subscription metrics.
 * Founded in 2007 by Tien Tzuo, it went public on the NYSE in 2018
 * under the ticker ZUO. In 2025 it was taken private by private-equity
 * firm Silver Lake together with Singapore's sovereign wealth fund
 * GIC. The global hiring footprint (Tokyo, Chennai, Costa Rica) and
 * roles such as Account Executive, AI Solutions Engineer, and Customer
 * Solution Engineer are consistent with its worldwide enterprise-SaaS
 * sales and engineering operations.
 *
 * Sector: Enterprise SaaS / Subscription Billing & Quote-to-Cash. HQ: Redwood City, California, USA.
 *
 * Highlights:
 *   - Headquartered in Redwood City, California; founded in 2007 by
 *     CEO Tien Tzuo
 *   - Flagship products include Zuora Billing, Zuora Revenue, and
 *     Zuora CPQ for the full quote-to-cash lifecycle
 *   - Listed on the NYSE in 2018 (ticker ZUO) before going private
 *   - Taken private in 2025 by Silver Lake and Singapore's GIC
 *   - Operates globally with offices and hiring across the Americas,
 *     EMEA, and APAC (e.g., Tokyo, Chennai, Costa Rica)
 *
 * Source profile (Spec 803):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/zuora/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Zuora'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 34 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/zuora/jobs';

@SourcePlugin({
  site: Site.ZUORA,
  name: 'Zuora',
  category: 'company',
})
@Injectable()
export class ZuoraService implements IScraper {
  private readonly logger = new Logger(ZuoraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Zuora: fetching ${url}`);

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
        const id = `zuora-${jobId}`;

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
            site: Site.ZUORA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Zuora',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/zuora/jobs/${listing.id}`,
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

      this.logger.log(`Zuora: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Zuora scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
