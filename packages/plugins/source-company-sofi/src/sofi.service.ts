import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Social Finance, Inc. (SoFi Technologies) — operator of the
 * **dominant US-domestic super-app fintech platform pioneered
 * around the consumer-banking + investing + lending data model**
 * (founded by Mike Cagney, Dan Macklin, James Finnigan, and Ian
 * Brady in August 2011 at the Stanford Graduate School of
 * Business as a student-loan-refi marketplace; expanded into
 * personal lending, mortgages, banking (de novo OCC charter
 * granted 2022 via the Golden Pacific Bancorp acquisition),
 * brokerage (SoFi Invest), credit cards, insurance, and the
 * Galileo / Technisys B2B fintech-platform-as-a-service stack;
 * Nasdaq-listed (SOFI) since 2021 SPAC merger with Social
 * Capital Hedosophia V at a $9B valuation; ships consumer and
 * institutional fintech products across the super-app /
 * neobank / B2B-fintech-PaaS segment — alongside competitors
 * Robinhood, Affirm, Block, Chime, LendingClub, Capital One,
 * and Marqeta — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), New York, Frisco TX,
 * Cottonwood Heights UT, Seattle WA, Helena MT, and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `sofi`
 * (the lowercase concatenated brand-stem; case-asymmetric with
 * the wire `company_name === 'SoFi'` PascalCase concat — same
 * byte-count (4 bytes) but byte-distinct via case at TWO
 * indices — see Spec 102 § 10 D-05).
 *
 * **One structural deviation from the Klaviyo (Spec 042)
 * template** — D-04 wire-shape variant 28 (NEW — first cohort
 * plugin to use variant 28; bare brand-domain `sofi.com` +
 * `/careers/job/` path + path-id + query-id; sister to variant
 * 19 with bare-brand-domain instead of `www.`-prefix).
 *
 *   1. **D-04 — wire-shape variant 28 (bare brand-domain
 *      `/careers/job/` path-id + query-id — first cohort
 *      observation).** SoFi publishes `absolute_url` on
 *      `https://sofi.com/careers/job/<id>?gh_jid=<id>` with
 *      four sub-axes:
 *      a) **Bare brand-domain `sofi.com`** — same as variants
 *         13/15/18/23/27; distinct from variant 19 (Klaviyo's
 *         `www.klaviyo.com/careers/job/...`) which uses the
 *         `www.`-prefixed form on the same path structure.
 *      b) **`/careers/job/` path** — same `/careers/` ancestor
 *         + `/job/` parent shape as variant 19 (Klaviyo). First
 *         cohort observation of bare-brand-domain on the
 *         variant-19 path layout.
 *      c) **Path-id `/job/<id>`** — same as variants 13/18/19/
 *         20/23/26/27 (cohort common shape on path-id placement).
 *      d) **Path-id + query-id dual-id `?gh_jid=<id>`** — same
 *         dual-id form as variants 13/19/26/27.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 28** — the **thirty-first distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/sofi/jobs/<id>`.
 *
 * Shared with Klaviyo:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FIRST-COHORT
 *     PascalCase TWO-INTERNAL-CAP same-byte-count case-
 *     asymmetric wire form.** Wire `company_name === 'SoFi'`
 *     byte-for-byte (4 bytes — fully clean; 0 of 204 padded).
 *     Slug `sofi` is 4 bytes lowercase; case-asymmetric at TWO
 *     byte indices — `'S'` vs `'s'` at index 0 AND `'F'` vs
 *     `'f'` at index 2. **First cohort observation of TWO-cap
 *     PascalCase same-byte-count case-asymmetry** — distinct
 *     from prior single-cap forms in DataCamp (Spec 075, cap
 *     at byte 4), HelloFresh (Spec 097, cap at byte 5), and
 *     PlanetScale (Spec 101, cap at byte 6). **Fifty-first
 *     cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     8 of 204 wire titles in the run-312 probe carry trailing
 *     ASCII-space padding (~3.9 % pad rate). **Twenty-seventh
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 204
 *     wire department names padded across 45 unique departments
 *     (`'Accounting'`, `'Affiliates'`, `'BUL'`, `'Banking
 *     Ops'`, `'Business Controls and Complaints'`, `'Capital
 *     Markets'`, `'Comms & Policy'`, `'Compliance'`, plus 37
 *     others — clean multi-token forms with internal whitespace,
 *     ampersands, and acronyms). **Forty-fourth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sofi/jobs';

@SourcePlugin({
  site: Site.SOFI,
  name: 'SoFi',
  category: 'company',
})
@Injectable()
export class SoFiService implements IScraper {
  private readonly logger = new Logger(SoFiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`SoFi: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 8/204 wire titles
        // padded (~3.9 %).
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
        const id = `sofi-${jobId}`;

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
            site: Site.SOFI,
            title,
            // D-09 omitted: FIRST-COHORT PascalCase two-internal-
            // cap same-byte-count case-asymmetric wire form.
            companyName: listing.company_name ?? 'SoFi',
            // D-04: wire `absolute_url` flows through (variant 28
            // — bare brand-domain + `/careers/job/` + path-id +
            // query-id); fallback uses canonical Greenhouse
            // variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sofi/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/204 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`SoFi: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`SoFi scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
