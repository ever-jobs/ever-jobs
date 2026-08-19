import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ansa — White-labeled stored-value and wallet-as-a-service infrastructure for merchants and marketplaces..
 *
 * Ansa is a San Francisco-based fintech company, founded in 2022, that
 * operates an API-first stored-value and "wallet-as-a-service"
 * platform. It provides white-labeled, closed-loop wallet
 * infrastructure that lets merchants and marketplaces embed customer
 * balances, prepaid funds, and incentives while Ansa handles the
 * underlying payments, ledger, accounting, and compliance. Its tooling
 * targets segments such as coffee shops, quick-service restaurants,
 * and marketplaces, and integrates with existing payment service
 * providers like Stripe, Square, and Braintree.
 *
 * Sector: Fintech / Payments infrastructure. HQ: San Francisco, USA.
 *
 * Highlights:
 *   - API-first, white-labeled closed-loop wallet platform for
 *     embedded customer balances
 *   - Handles payments, ledger, accounting, and regulatory/compliance
 *     complexity for merchants
 *   - Targets coffee shops, quick-service restaurants, and
 *     marketplaces
 *   - Integrates with existing PSPs such as Stripe, Square, and
 *     Braintree
 *   - Founded 2022 in San Francisco; hiring across GTM and Engineering
 *
 * Source profile (Spec 271):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ansa/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ansa'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 5 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ansa/jobs';

@SourcePlugin({
  site: Site.ANSA,
  name: 'Ansa',
  category: 'company',
})
@Injectable()
export class AnsaService implements IScraper {
  private readonly logger = new Logger(AnsaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ansa: fetching ${url}`);

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
        const id = `ansa-${jobId}`;

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
            site: Site.ANSA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ansa',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ansa/jobs/${listing.id}`,
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

      this.logger.log(`Ansa: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ansa scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
