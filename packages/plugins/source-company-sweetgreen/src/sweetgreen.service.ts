import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Sweetgreen, Inc. — operator of the **dominant US-domestic
 * fast-casual healthy-fresh-salad chain pioneered around the
 * digital-first / ingredient-traceability data model** (founded
 * by Nicolas Jammet, Nathaniel Ru, and Jonathan Neman in 2007 as
 * a single Georgetown University storefront in Washington, DC;
 * NYSE-listed (SG) since November 2021 IPO at a $5.6B initial
 * valuation; expanded to 200+ stores across the US with the
 * Bentonville-AR-based Spyce Labs robotic-kitchen acquisition
 * (2021) automating bowl assembly; ships salads, warm-bowls,
 * plates, and beverages across the fast-casual / better-for-you
 * segment — alongside competitors Cava, Chipotle, Salata, Just
 * Salad, and Tender Greens — with a hybrid distributed corporate
 * workforce concentrated across Los Angeles (HQ since 2016
 * relocation from DC), New York, Chicago, Boston, Bentonville
 * AR, and a store-level workforce distributed across all
 * operating metro markets) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `sweetgreen`
 * (the lowercase brand-name; case-symmetric AFTER trim with the
 * wire `company_name === ' sweetgreen'` 11-byte leading-space-
 * padded form — see Spec 104 § 10 D-05 / D-09).
 *
 * **Two structural deviations from the HelloFresh (Spec 097)
 * template** — D-04 wire-shape variant 29 (NEW — first cohort
 * plugin to use variant 29; careers-subdomain
 * `careers.sweetgreen.com` + root-level `/jobs/<id>` path-id +
 * query-id; sister to variant 26 with NO locale prefix); D-09
 * APPLIED with **first-cohort leading-space pad sub-axis** (vs
 * HelloFresh's omission with PascalCase byte-clean wire).
 *
 *   1. **D-04 — wire-shape variant 29 (careers-subdomain
 *      root-level `/jobs/` path-id + query-id — first cohort
 *      observation).** Sweetgreen publishes `absolute_url` on
 *      `https://careers.sweetgreen.com/jobs/<id>?gh_jid=<id>`
 *      with three sub-axes:
 *      a) **Brand-host careers-subdomain `careers.sweetgreen.com`**
 *         — same `careers.<brand-domain>` shape as variants 8
 *         (Toast `careers.toasttab.com`), 21 (Peloton
 *         `careers.onepeloton.com`), 26 (HelloFresh
 *         `careers.hellofresh.com`).
 *      b) **Root-level `/jobs/<id>` path-id (no locale prefix
 *         and no `/careers/` parent)** — distinct from variants
 *         21 (`/en/all-jobs/`), 26 (`/global/en/job/`), and 27
 *         (`/en-eu/careers/positions/`) which all carry locale
 *         segments; same root-level positioning as variant 8
 *         (Toast's `/jobs?...` query-only) but Sweetgreen adds
 *         the path-id. Plural `/jobs/` collection name (vs
 *         variants 13 Epic Games' plural `/careers/jobs/<id>`,
 *         and the various singular `/job/<id>` variants 18/19/
 *         24/26).
 *      c) **Path-id + query-id dual-id `?gh_jid=<id>`** — same
 *         dual-id form as variants 13/19/26/27/28.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 29** — the **thirty-second distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/sweetgreen/jobs/<id>`.
 *
 *   2. **D-09 — wire-`company_name` `.trim()` applied with
 *      LEADING-space pad sub-axis.** All 44 wire `company_name`
 *      records carry a single leading ASCII space —
 *      `' sweetgreen'` byte-for-byte (11 bytes; trim → 10-byte
 *      `'sweetgreen'`). 100 % pad rate. Same trim-direction
 *      sub-axis as DataCamp's run-291 first-ever D-11 leading-
 *      pad observation, but on the D-09 axis. **Second cohort
 *      plugin to apply D-09** (after Fivetran's run-292 first-
 *      ever trailing-space `'Fivetran '` application) and
 *      **first cohort observation of LEADING-space D-09
 *      application**, lifting the directionality sub-axis on
 *      D-09 from a single trailing-pad form to a recurring
 *      leading-AND-trailing pattern.
 *
 * Shared with HelloFresh:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixtieth** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 44 wire titles in the run-314 probe carry trailing
 *     ASCII-space padding (~6.8 % pad rate). **Twenty-eighth
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with
 *     STORE-LOCATION department names.** 0 of 44 wire department
 *     names padded across 39 unique department records. The
 *     departments are **store-location identifiers** (e.g.
 *     `'16th + Market'`, `'16th + Pearl'`, `'52nd + Lex'`,
 *     `'67th + Columbus'`, `'Back Bay'`, `'Bentonville'`,
 *     `'Berkeley'`) rather than functional categories — **first
 *     cohort observation of departments-as-store-locations
 *     under D-11**. **Forty-fifth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sweetgreen/jobs';

@SourcePlugin({
  site: Site.SWEETGREEN,
  name: 'sweetgreen',
  category: 'company',
})
@Injectable()
export class SweetgreenService implements IScraper {
  private readonly logger = new Logger(SweetgreenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`sweetgreen: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/44 wire titles
        // padded (~6.8 %).
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
        const id = `sweetgreen-${jobId}`;

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
            site: Site.SWEETGREEN,
            title,
            // D-09 APPLIED (leading-pad form — first cohort
            // observation): wire ` sweetgreen` 11 bytes →
            // trim → 10-byte `sweetgreen`. Defensive fallback
            // is already trimmed.
            companyName: (listing.company_name ?? 'sweetgreen').trim(),
            // D-04: wire `absolute_url` flows through (variant 29
            // — careers-subdomain root-level `/jobs/` path-id +
            // query-id); fallback uses canonical Greenhouse
            // variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sweetgreen/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/44 wire departments padded across
            // 39 store-location department names.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`sweetgreen: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`sweetgreen scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
