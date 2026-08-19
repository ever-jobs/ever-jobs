import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * GoCardless Ltd. — operator of the **dominant bank-debit
 * recurring-payments-as-a-service platform pioneered around
 * the direct-debit / bank-payment data model** (founded by
 * Hiroki Takeuchi, Matt Robinson, and Tom Blomfield in 2011
 * in London, UK; private since the 2022 Series G round at
 * ~$2.1B unicorn valuation; ships GoCardless Direct Debit,
 * Instant Bank Pay, Protect+ (AI fraud / verified-mandates),
 * and Embedded Finance APIs across the bank-payment /
 * payment-orchestration / SME-fintech vertical — alongside
 * competitors Stripe, Adyen, Plaid Pay-by-Bank, Bottomline,
 * and Token.io — with a hybrid distributed workforce
 * concentrated across London (HQ), Paris, Munich, Melbourne,
 * and Remote across the United Kingdom, Europe, the United
 * States, and APAC) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `gocardless`
 * (case-asymmetric with the wire `company_name ===
 * 'GoCardless'` PascalCase concat — same byte-count (10
 * bytes) but byte-distinct via case at TWO indices: 0 (`G`
 * vs `g`) and 2 (`C` vs `c`); see Spec 150 § 10 D-09).
 *
 * **Zero structural deviations from the PagerDuty (Spec 117)
 * template** — making this the **thirty-ninth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with PagerDuty,
 * with a notable D-09 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/gocardless/jobs/<id>`.
 *     **Fifty-eighth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with TWO-cap PascalCase
 *     case-asymmetric wire form.** Wire `company_name ===
 *     'GoCardless'` byte-for-byte (10 bytes — fully clean;
 *     0 of 41 padded). Slug `gocardless` is 10 bytes
 *     lowercase; case-asymmetric at TWO byte indices: 0 (`G`
 *     vs `g`) and 2 (`C` vs `c`). **7th cohort plugin with
 *     TWO-cap PascalCase D-09 sub-axis** after SoFi (caps
 *     0/2), StockX (caps 0/5), xAI (caps 0/2 lowercase
 *     first), LaunchDarkly (caps 0/6), PagerDuty (caps 0/5),
 *     and ComplyAdvantage (caps 0/6). **Caps-at-0/2 matches
 *     SoFi (Spec 102) and xAI (Spec 105) exactly** — third
 *     cohort plugin with caps-at-0/2 sub-pattern; distinct
 *     from xAI by being uppercase-first (xAI is lowercase-
 *     first). **Ninety-seventh cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 41 wire titles in the run-360 probe carries
 *     trailing ASCII-space padding (~2.4 % pad rate; `'Site
 *     Reliability Engineer '`). **Sixty-fifth cohort plugin
 *     to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 41
 *     wire department names padded across 6 unique
 *     departments (`'Customer'`, `'Marketing'`, `'People'`,
 *     `'Product Development'`, `'Risk'`, `'Sales'` — clean
 *     single-token / two-token forms). Pass-through preserves
 *     byte-for-byte. **Eighty-fifth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/gocardless/jobs';

@SourcePlugin({
  site: Site.GOCARDLESS,
  name: 'GoCardless',
  category: 'company',
})
@Injectable()
export class GocardlessService implements IScraper {
  private readonly logger = new Logger(GocardlessService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`GoCardless: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/41 wire titles
        // padded (~2.4 %).
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
        const id = `gocardless-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.GOCARDLESS,
            title,
            // D-09 omitted: TWO-cap PascalCase case-asymmetric
            // wire form 'GoCardless' (caps 0/2).
            companyName: listing.company_name ?? 'GoCardless',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/gocardless/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/41 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`GoCardless: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`GoCardless scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
