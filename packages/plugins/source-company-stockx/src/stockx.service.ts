import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * StockX, LLC. — operator of the **dominant
 * authentication-first secondary-marketplace platform pioneered
 * around the live-bid-and-ask sneakers / streetwear / collectibles
 * data model** (founded by Josh Luber, Greg Schwartz, Dan
 * Gilbert (the Quicken Loans / Cleveland Cavaliers founder), and
 * Chris Kaufman in 2015 in Detroit; raised ~$695M across rounds
 * at peak ~$3.8B valuation in April 2021 led by Tiger Global,
 * Whale Rock, and Altimeter Capital; pivoted from a flip-only
 * marketplace to a Stock-X-branded "current culture stock-
 * exchange" with global authentication centers; ships sneakers,
 * streetwear, electronics, trading cards, and collectibles
 * across the secondary-resale segment — alongside competitors
 * GOAT, eBay Authenticity Guarantee, Grailed, Sotheby's
 * collectibles, and Whatnot — with a hybrid distributed
 * workforce concentrated across Detroit (HQ), New York,
 * London, Tokyo, Bangalore, Eindhoven, and Remote across the
 * United States) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `stockx` (the lowercase
 * concatenated brand-stem; case-asymmetric with the wire
 * `company_name === 'StockX'` PascalCase concat — same byte-
 * count (6 bytes) but byte-distinct via case at TWO indices —
 * see Spec 103 § 10 D-05).
 *
 * **One structural deviation from the DataCamp (Spec 075)
 * template** — D-11 sub-axis: StockX's `'Customer Service '`
 * trailing-space pad form vs DataCamp's `' IT'` leading-space
 * pad form. Both apply D-11; the deviation is on the pad-
 * directionality sub-axis only.
 *
 *   1. **D-11 — wire-department `.trim()` applied (trailing-
 *      pad form on a single department record).** 5 of 25
 *      listings carry `departments[0].name === 'Customer
 *      Service '` with single-trailing-ASCII-space padding (1
 *      of 7 unique department names is padded; ~20 % listing-
 *      level pad rate). Distinct from DataCamp's leading-pad
 *      form. **Seventh cohort plugin to apply D-11** (after
 *      Lattice / DataCamp / Typeform / BILL / Dollar Shave
 *      Club / HelloFresh).
 *
 * Shared with DataCamp:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/stockx/jobs/<id>`.
 *     **Twenty-ninth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with PascalCase TWO-cap
 *     same-byte-count case-asymmetry.** Wire `company_name ===
 *     'StockX'` byte-for-byte (6 bytes, PascalCase concat;
 *     same byte-count as the lowercase 6-byte slug `stockx`
 *     but byte-distinct via case at TWO indices — `'S'` vs
 *     `'s'` at index 0 AND `'X'` vs `'x'` at index 5).
 *     **Second cohort observation of TWO-cap PascalCase same-
 *     byte-count case-asymmetry** (after SoFi's run-312 first-
 *     ever observation at indices 0/2 — StockX's caps at
 *     indices 0/5 are positionally distinct). **Fifty-second
 *     cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 25 wire
 *     titles in the run-313 probe carry whitespace padding.
 *     **Twenty-first cohort plugin to omit D-10**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/stockx/jobs';

@SourcePlugin({
  site: Site.STOCKX,
  name: 'StockX',
  category: 'company',
})
@Injectable()
export class StockXService implements IScraper {
  private readonly logger = new Logger(StockXService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`StockX: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/25 wire titles padded — pass through.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied (trailing-pad form): 5/25 listings carry
        // `'Customer Service '` with single-trailing-ASCII-space
        // padding. Trim BEFORE searchTerm guard so case-
        // insensitive department matches honour the trimmed form.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `stockx-${jobId}`;

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
            site: Site.STOCKX,
            title,
            // D-09 omitted: PascalCase TWO-cap case-asymmetric
            // wire form (caps at byte indices 0 and 5).
            companyName: listing.company_name ?? 'StockX',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/stockx/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trimmed wire department.
            department,
          }),
        );
      }

      this.logger.log(`StockX: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`StockX scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
