import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * HelloFresh SE — operator of the **dominant European meal-kit
 * subscription platform pioneered around the weekly recipe-and-
 * ingredient-shipment data model** (founded by Dominik Richter,
 * Thomas Griesel, and Jessica Nilsson in November 2011 in Berlin;
 * Frankfurt-listed (HFG) since November 2017 at €1.7B initial
 * IPO valuation; expanded across 18+ countries via the HelloFresh,
 * EveryPlate, Green Chef, Chefs Plate, Factor, Goodchop, and
 * YouFoodz brands; ships weekly meal-kit subscriptions and
 * heat-and-eat ready meals across the meal-kit segment —
 * alongside competitors Blue Apron (acquired 2023 by Wonder),
 * Sunbasket, Marley Spoon, and Gousto — with a hybrid distributed
 * workforce concentrated across Berlin (HQ), Amsterdam, New York,
 * Sydney, Toronto, London, and Remote across Europe / North
 * America / APAC) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `hellofresh` (the lowercase
 * concatenated brand-stem; case-asymmetric with the wire
 * `company_name === 'HelloFresh'` PascalCase concat — same byte-
 * count (10 bytes) but byte-distinct via case at byte index 5).
 *
 * **Three structural deviations from the BILL (Spec 092)
 * template** — D-04 wire-shape variant 26 (NEW — first cohort
 * plugin to use variant 26; brand-host careers-subdomain
 * `careers.hellofresh.com` + dual-segment locale prefix
 * `/global/en/` + path-id `/job/<id>` + single `gh_jid` query);
 * D-09 omitted with case-asymmetric PascalCase wire form (vs
 * BILL's all-caps); D-11 applied with high-pad-rate trailing-pad
 * form (43/368 ~11.7 % vs BILL's ~39.1 %).
 *
 *   1. **D-04 — wire-shape variant 26 (brand-host careers-
 *      subdomain dual-segment-locale-prefix path-id+query-id —
 *      first cohort observation).** HelloFresh publishes
 *      `absolute_url` on
 *      `https://careers.hellofresh.com/global/en/job/<id>?gh_jid=<id>`
 *      with four distinguishing sub-axes:
 *      a) **Brand-host careers-subdomain `careers.hellofresh.com`**
 *         — same `careers.<brand-domain>` shape as variants 8
 *         (Toast `careers.toasttab.com`) and 21 (Peloton
 *         `careers.onepeloton.com`); distinct from the apex-
 *         brand-domain variants (13/15/18/23) and the `www.`-
 *         prefixed variants (16/19/20/24/25).
 *      b) **Dual-segment locale prefix `/global/en/`** — TWO
 *         leading path segments before the listing path; same
 *         dual-segment structure as variant 21 (Peloton's
 *         `/en/all-jobs/`) but with a `/global/` ancestor
 *         segment ahead of the language code. **First cohort
 *         observation** of a dual-segment locale-prefix that
 *         starts with a `/global/` region-cluster ancestor.
 *      c) **Path-id `/job/<id>`** — the listing ID appears as a
 *         path segment. Same path-id sub-axis as variants 13/18/
 *         19/20/23/25 (which all use a `/<id>` or `/<id>?...`
 *         path-id segment) but distinct from variant 24 (BILL's
 *         dual-id `?<id>&gh_jid=<id>` — bare-id-as-query) and
 *         variant 21 (Peloton's `/all-jobs/` — path-only-list,
 *         no path-id).
 *      d) **Dual-id (path + query) `?gh_jid=<id>`** — the
 *         listing ID also appears as the canonical `gh_jid=`
 *         query value. Distinct from variant 24 (BILL — dual-id
 *         BARE-query-token + gh_jid) and from the single-id-
 *         path variants (13/15/18/23 — ID in path only, no
 *         query). **First cohort observation** of a path-id +
 *         query-id dual-id form (path-id-and-query-id rather
 *         than BILL's bare-id-and-query-id).
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 26** — the **twenty-ninth distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/hellofresh/jobs/<id>`.
 *
 *   2. **D-09 — brand-name trim omitted with PascalCase
 *      case-asymmetric wire form.** Wire `company_name ===
 *      'HelloFresh'` byte-for-byte (10 bytes, PascalCase concat;
 *      same byte-count as the lowercase 10-byte slug `hellofresh`
 *      but byte-distinct via case alone at byte index 5 —
 *      `'F'` vs `'f'`). Same case-only-asymmetric same-byte-
 *      count shape as DataCamp (Spec 075). 0 of 368 padded.
 *      **Forty-sixth cohort plugin to omit D-09**.
 *
 *   3. **D-11 — wire-department `.trim()` applied.** 43 of 368
 *      wire department-name records padded with single-trailing-
 *      ASCII-space form (`'Operations '`, `'Marketing '`, etc.;
 *      ~11.7 % listing-level pad rate). **Sixth cohort plugin
 *      to apply D-11** (after Lattice's run-284 first-ever
 *      trailing-pad, DataCamp's run-291 first-ever leading-pad,
 *      Typeform's run-299 second trailing-pad, BILL's run-302
 *      high-pad-rate trailing, and Dollar Shave Club's run-306
 *      partial trailing-pad).
 *
 * Shared with BILL:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-third** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     57 of 368 wire titles padded with single-trailing-ASCII-
 *     space form (e.g. `'Asset Protection Specialist '`,
 *     `'Chief Marketing Officer - DACH '`; ~15.5 % pad rate —
 *     mid-range vs prior cohort observations: Squarespace ~25 %,
 *     New Relic ~21.6 %, Adyen ~10 %, Faire ~9.7 %). **Twenty-
 *     third cohort plugin to apply D-10**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/hellofresh/jobs';

@SourcePlugin({
  site: Site.HELLOFRESH,
  name: 'HelloFresh',
  category: 'company',
})
@Injectable()
export class HelloFreshService implements IScraper {
  private readonly logger = new Logger(HelloFreshService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`HelloFresh: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 57/368 wire titles
        // padded (~15.5 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 43/368 wire dept
        // names padded (~11.7 %). Trim BEFORE searchTerm guard
        // so case-insensitive department matches honour trimmed.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `hellofresh-${jobId}`;

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
            site: Site.HELLOFRESH,
            title,
            // D-09 omitted: case-asymmetric PascalCase bare-brand
            // wire `'HelloFresh'`.
            companyName: listing.company_name ?? 'HelloFresh',
            // D-04: wire `absolute_url` flows through (variant 26
            // — careers-subdomain + dual-segment locale + path-
            // id + query-id); fallback uses canonical Greenhouse
            // variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/hellofresh/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (trailing-pad form): trimmed wire dept.
            department,
          }),
        );
      }

      this.logger.log(`HelloFresh: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`HelloFresh scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
