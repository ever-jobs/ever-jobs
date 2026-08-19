import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Misfits Market, Inc. — operator of the **dominant North-
 * American imperfect-produce-and-grocery direct-to-consumer
 * subscription platform pioneered around the surplus / cosmetic-
 * mismatch / discount-grocery data model** (founded by Abhi
 * Ramesh in 2018 in Philadelphia; raised ~$526M across rounds
 * at peak ~$2B valuation in September 2021 led by SoftBank
 * Vision Fund 2; acquired Imperfect Foods in 2022 for ~$200M to
 * consolidate the cohort and expand the cold-chain footprint;
 * ships discounted produce, pantry, dairy, meat, and prepared-
 * meal subscriptions across the US grocery-D2C segment —
 * alongside competitors Hungryroot, Thrive Market, FreshDirect,
 * and Imperfect Foods (now wholly-owned subsidiary) — with a
 * distributed cold-chain workforce concentrated across
 * Philadelphia, Delanco NJ, Northlake IL, Pittston PA, and
 * Phoenix AZ) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `misfitsmarket` (the lowercase
 * concatenated brand-name; case-AND length-asymmetric with the
 * wire `company_name === 'Misfits Market'` two-word brand with
 * internal ASCII space — see Spec 098 § 10 D-05).
 *
 * **Zero structural deviations from the New Relic (Spec 085)
 * template** — making this the **eleventh** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera, Flexport, Glossier, Marqeta, New Relic,
 * Scopely, Adyen, Bobbie, Cerebral, plus a corrected count). All
 * five primary axes share with New Relic:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/misfitsmarket/jobs/<id>`.
 *     **Twenty-sixth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with INTERNAL-WHITESPACE
 *     wire asymmetry.** Wire `company_name === 'Misfits Market'`
 *     byte-for-byte (14 bytes — two-word brand with internal
 *     ASCII space at index 7; case-AND length-asymmetric vs the
 *     lowercase 13-byte concatenated slug `misfitsmarket`).
 *     **Sixth** internal-whitespace asymmetry case in the
 *     cohort (after Scale AI's run-274 first-ever, Maven Clinic,
 *     Stitch Fix, New Relic, and Dollar Shave Club). 0 of 44
 *     padded. **Forty-seventh cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     6 of 44 wire titles in the run-308 probe carry trailing
 *     ASCII-space padding (~13.6 % pad rate — mid-range cohort
 *     position). **Twenty-fourth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 44
 *     wire department names padded (`'Distribution'`,
 *     `'Marketing'`, `'Merchandising'`, `'Operations'`,
 *     `'Safety'` — clean single-token forms). **Fortieth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/misfitsmarket/jobs';

@SourcePlugin({
  site: Site.MISFITSMARKET,
  name: 'Misfits Market',
  category: 'company',
})
@Injectable()
export class MisfitsMarketService implements IScraper {
  private readonly logger = new Logger(MisfitsMarketService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Misfits Market: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 6/44 wire titles
        // padded (~13.6 %).
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
        const id = `misfitsmarket-${jobId}`;

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
            site: Site.MISFITSMARKET,
            title,
            // D-09 omitted: internal-whitespace wire asymmetry.
            companyName: listing.company_name ?? 'Misfits Market',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/misfitsmarket/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/44 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Misfits Market: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Misfits Market scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
