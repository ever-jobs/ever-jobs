import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * BitGo Holdings, Inc. — operator of the **dominant
 * institutional-crypto-custody and digital-asset-trust
 * platform pioneered around the multi-signature cold-storage
 * data model** (founded by Mike Belshe and Ben Davenport in
 * 2013 in Palo Alto, CA; private since the 2023 Series C
 * round at ~$1.75B unicorn valuation; ships BitGo Custody
 * (multi-sig wallets + qualified-trust storage), BitGo Trust
 * (regulated trust company), BitGo Prime (institutional
 * trading + lending), and BitGo Portfolio (digital-asset
 * analytics) across the institutional-crypto / digital-
 * asset-custody / regulated-trust vertical — alongside
 * competitors Anchorage Digital, Coinbase Custody, Fireblocks,
 * and NYDIG — with a hybrid distributed workforce
 * concentrated across Palo Alto (HQ), New York, and Remote
 * across the United States, Europe, and APAC) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `bitgo` (case-asymmetric with the wire
 * `company_name === 'BitGo'` PascalCase concat — same byte-
 * count (5 bytes) but byte-distinct via case at TWO indices:
 * 0 (`B` vs `b`) and 3 (`G` vs `g`); see Spec 154 § 10
 * D-09).
 *
 * **Zero structural deviations from the PagerDuty (Spec 117)
 * template** — making this the **forty-first** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with PagerDuty,
 * with notable D-09 + D-10 sub-axis observations:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/bitgo/jobs/<id>`.
 *     **Sixty-first** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-tenth** cohort plugin to apply D-08
 *     — **the cohort crosses the 110-plugin D-08-application
 *     threshold at this run.**
 *
 *   - **D-09 — brand-name trim omitted with TWO-cap PascalCase
 *     case-asymmetric wire form.** Wire `company_name ===
 *     'BitGo'` byte-for-byte (5 bytes — fully clean; 0 of 47
 *     padded). Slug `bitgo` is 5 bytes lowercase; case-
 *     asymmetric at TWO byte indices: 0 (`B` vs `b`) and 3
 *     (`G` vs `g`). **8th cohort plugin with TWO-cap
 *     PascalCase D-09 sub-axis** after SoFi (caps 0/2),
 *     StockX (caps 0/5), xAI (caps 0/2 lowercase first),
 *     LaunchDarkly (caps 0/6), PagerDuty (caps 0/5),
 *     ComplyAdvantage (caps 0/6), and GoCardless (caps 0/2).
 *     **NEW caps-at-0/3 sub-pattern** — distinct from all
 *     prior TWO-cap PascalCase plugins. **One-hundred-and-
 *     first cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (mixed pad form).**
 *     5 of 47 wire titles in the run-364 probe carry pad
 *     bytes (~10.6 % pad rate). 1 trailing-pad (`'Backend
 *     Engineer E2 - Trade '`) + **1 triple-trailing-space
 *     pad** (`'Mobile Software Engineer E3 - (React Native)
 *     '` — 3 ASCII trailing spaces; **2nd cohort observation
 *     of triple-pad form** after Formlabs Spec 147) + **3
 *     leading-pad** (`' Senior Director Risk Management'` —
 *     same title across 3 listings; **6th cohort observation
 *     of leading-pad sub-axis** after Chainguard / Oscar /
 *     Celonis / Formlabs / GoFundMe). `.trim()` is byte-
 *     count agnostic and handles all pad widths and positions
 *     transparently. **Sixty-ninth cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 47
 *     wire department names padded across 11 unique
 *     departments (`'Compliance'`, `'Digital Technology'`,
 *     `'Engineering'`, `'Finance'`, `'Marketing'`,
 *     `'Operations'`, `'Risk'`, `'Sales'`, `'Sales
 *     Solutions'`, `'Security'`, `'Trust'`). Pass-through
 *     preserves byte-for-byte. **Eighty-eighth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bitgo/jobs';

@SourcePlugin({
  site: Site.BITGO,
  name: 'BitGo',
  category: 'company',
})
@Injectable()
export class BitgoService implements IScraper {
  private readonly logger = new Logger(BitgoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BitGo: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed pad form): 5/47 wire titles
        // padded (~10.6 %); 1 trailing + 1 triple-trailing-
        // space + 3 leading-pad samples. `.trim()` strips all
        // whitespace at both ends transparently.
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
        const id = `bitgo-${jobId}`;

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
            site: Site.BITGO,
            title,
            // D-09 omitted: TWO-cap PascalCase case-asymmetric
            // wire form 'BitGo' (caps 0/3 — NEW sub-pattern).
            companyName: listing.company_name ?? 'BitGo',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bitgo/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/47 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`BitGo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BitGo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
