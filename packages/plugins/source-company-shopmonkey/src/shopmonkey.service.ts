import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Shopmonkey, Inc. (Shopmonkey.io) — operator of the
 * **vertical-SaaS shop-management + point-of-sale platform
 * pioneered around the all-in-one auto-repair-shop /
 * independent-mechanic / collision-shop operations data
 * model** (founded by Ashot Iskandarian in 2016 in Morgan
 * Hill, California; raised ~$285M across rounds at peak
 * ~$1.5B valuation in June 2022 led by Bessemer Venture
 * Partners, Index Ventures, and Headline; ships Shopmonkey
 * Cloud (cloud-native shop-management — repair orders,
 * inventory, parts ordering, customer communications),
 * Shopmonkey Pay (integrated card-present / card-not-
 * present payments), Shopmonkey Marketing (lead-capture +
 * appointment scheduling), and Shopmonkey Reporting
 * (operational analytics) across the auto-repair-shop /
 * collision-shop / vertical-SaaS POS segment — alongside
 * competitors Tekmetric, Mitchell 1, ALLDATA, NAPA TRACS,
 * RepairShopr, and AutoLeap — with a hybrid distributed
 * workforce concentrated across Morgan Hill (HQ), Las
 * Vegas, and Remote across the United States) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `shopmonkey` (case-symmetric with the wire
 * `company_name === 'Shopmonkey'`; see Spec 170 § 10 D-05).
 *
 * **One D-10 sub-axis deviation from the Justworks (Spec 129)
 * template** — Justworks D-10 was applied (5 of 82 padded
 * with first-cohort double-trailing-space pad form), whereas
 * Shopmonkey D-10 is **OMITTED** (0 of 9 wire titles padded
 * — fully-clean title set; no `.trim()` operation). **Forty-
 * ninth near-clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/shopmonkey/jobs/<id>?gh_jid=<id>`.
 *     **Eighth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, Flexport, Braze, Descript, Justworks, Founders).
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Shopmonkey'` byte-for-byte (10 bytes —
 *     fully clean, case-symmetric with the lowercase 10-byte
 *     slug `shopmonkey`).
 *
 *   4. **D-10 — wire-title trim OMITTED.** 0 of 9 wire titles
 *      in the run-380 probe carry whitespace padding. The
 *      plugin emits `listing.title` byte-for-byte without a
 *      `.trim()`. Distinct from Justworks (D-10 applied) by
 *      sub-axis only — the wire surface here observes a
 *      fully-clean title set.
 *
 *   5. **D-11 — fully-clean department pass-through.** 0 of 6
 *      unique wire department names padded (`'Business
 *      Development'`, `'Engineering'`, `'General- DNU'`,
 *      `'Implementation'`, `'Product Management'`, `'Sales
 *      Development'` — clean multi-token forms with internal
 *      whitespace and internal hyphenation; `'General- DNU'`
 *      is an archive marker carried byte-for-byte).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/shopmonkey/jobs';

@SourcePlugin({
  site: Site.SHOPMONKEY,
  name: 'Shopmonkey',
  category: 'company',
})
@Injectable()
export class ShopmonkeyService implements IScraper {
  private readonly logger = new Logger(ShopmonkeyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Shopmonkey: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/9 wire titles padded — emit byte-
        // for-byte without `.trim()`.
        const title = listing.title ?? '';
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
        const id = `shopmonkey-${jobId}`;

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
            site: Site.SHOPMONKEY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Shopmonkey',
            // D-04: wire `absolute_url` flows through (variant
            // 10 — legacy hosted-board apex
            // `boards.greenhouse.io/shopmonkey/jobs/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/shopmonkey/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/6 unique wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Shopmonkey: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Shopmonkey scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
