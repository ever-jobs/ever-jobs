import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Peloton Interactive, Inc. — operator of the dominant connected-
 * fitness platform pioneered around the on-demand-and-live-streamed
 * cycling-and-treadmill-instructor data model (founded by John
 * Foley in 2012 in New York City; IPO'd on NASDAQ as `PTON` in
 * September 2019; ships connected-bike, connected-tread, and
 * Peloton Guide / App-only subscription services across the
 * connected-fitness segment — alongside competitors Hydrow, Tonal,
 * NordicTrack, iFit, and Apple Fitness+ — with a hybrid distributed
 * workforce concentrated across New York City, Toronto, London,
 * Berlin, Atlanta, and Remote across the United States, Canada,
 * the United Kingdom, and Germany) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `peloton` (the
 * lowercase concatenated single-word brand; case-symmetric with
 * the wire `company_name === 'Peloton'`; see Spec 086 § 10 D-05).
 * The wire `company_name` is the literal single-token bare-brand
 * string `'Peloton'` byte-for-byte (7 bytes; case-symmetric with
 * the lowercase 7-byte slug).
 *
 * **One structural deviation from the Marqeta (Spec 084) template**
 * — D-04 wire-shape variant 21 (the **first cohort plugin to use
 * this previously-unobserved shape**: brand-host careers-subdomain
 * `careers.onepeloton.com` with locale-prefix path segment `/en/`
 * and multi-segment listing path with trailing slash `/all-jobs/`,
 * followed by the `?gh_jid=<id>` query-only listing identifier).
 * Distinct from Toast's variant 8 (`careers.toasttab.com/jobs?
 * gh_jid=<id>` — single-segment path, no locale prefix, no
 * trailing slash) and ZoomInfo's variant 9 (`www.zoominfo.com/
 * careers?gh_jid=<id>` — apex-www, single-segment path, no locale
 * prefix). The **twenty-second distinct wire-shape variant**
 * observed across the cohort.
 *
 * Shared with Marqeta:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Peloton's `content`
 *     is HTML-entity-encoded (`&lt;p&gt;&lt;strong&gt;ABOUT THE
 *     ROLE&amp;nbsp;&lt;/strong&gt;&lt;/p&gt;\n&lt;p&gt;The
 *     Associate Manager, Marketing Web Strategy will be responsible
 *     for briefing, executing, reporting, and optimizing...`), so
 *     the plugin decodes entities BEFORE stripping tags. **Forty-
 *     second** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Peloton'` byte-for-byte (the single-token
 *     bare brand name; case-symmetric with the lowercase slug
 *     `peloton`); no legal-entity suffix on the wire — distinct
 *     from the legal-entity name "Peloton Interactive, Inc." that
 *     appears in current SEC filings under NASDAQ ticker `PTON`.
 *     The plugin reads `listing.company_name` directly with
 *     `'Peloton'` as a defensive fallback. **Thirty-fifth cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 2 of 52 wire titles
 *     in the run-296 probe carry trailing ASCII-space padding
 *     (`'Senior Full Stack Software Engineer, Device Services '`,
 *     `'Software Engineer III, Social '` — both single-trailing-
 *     space-padded; ~3.85 % pad rate — the **new cohort low**,
 *     undercutting Calendly's prior 5.0 % low and Marqeta's 6.1 %
 *     rate). The plugin applies `.trim()` to the wire `title`
 *     before downstream filters and emit. **Twenty-second cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** Peloton's
 *     wire department names are 0 of 12 padded (0 % pad rate —
 *     `'Marketing'`, `'Sales'`, `'Data Analytics'`, `'Hardware'`,
 *     `'Supply Chain & Logistics'`, `'Software'`, `'People'`,
 *     `'Legal'`, `'Studio & Content Production'`, `'Product
 *     Development'` — clean multi-token forms with internal
 *     whitespace and ampersands). The plugin emits the wire
 *     `departments[0].name` byte-for-byte without a `.trim()`.
 *     **Thirty-second cohort plugin** with fully-clean department
 *     pass-through.
 *
 * Diverging from Marqeta (the **only structural deviation**):
 *
 *   - **D-04 — wire-shape variant 21 (brand-host careers-subdomain
 *     with locale-prefix and multi-segment listing path with
 *     trailing slash, followed by `?gh_jid=<id>`).** Peloton
 *     publishes `absolute_url` on
 *     `https://careers.onepeloton.com/en/all-jobs/?gh_jid=<id>` —
 *     a previously-unobserved wire-shape variant. The
 *     `careers.onepeloton.com` subdomain is on the brand domain
 *     `onepeloton.com`; the path carries a locale-prefix segment
 *     `/en/` followed by the multi-segment listing path
 *     `/all-jobs/` with trailing slash; the listing identifier is
 *     query-only via `?gh_jid=<id>`. **First cohort plugin to use
 *     variant 21**, the **twenty-second distinct wire-shape
 *     variant** observed across the cohort. Pass-through emits the
 *     wire `absolute_url` byte-for-byte; fallback constructor uses
 *     the canonical Greenhouse variant-2 form
 *     `https://job-boards.greenhouse.io/peloton/jobs/<id>` — NOT
 *     variant 21 (defensive fallback when wire omits
 *     `absolute_url`; matches the ClassPass / Spec 067 precedent of
 *     using variant 2 fallback even when the wire uses a non-2
 *     variant).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/peloton/jobs';

@SourcePlugin({
  site: Site.PELOTON,
  name: 'Peloton',
  category: 'company',
})
@Injectable()
export class PelotonService implements IScraper {
  private readonly logger = new Logger(PelotonService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Peloton: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 2/52 padded in run-296 probe
        // (~3.85 % — new cohort low).
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
        const id = `peloton-${jobId}`;

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
            site: Site.PELOTON,
            title,
            // D-09 omitted: case-symmetric bare-brand wire form.
            companyName: listing.company_name ?? 'Peloton',
            // D-04: wire `absolute_url` flows through (variant 21 —
            // first cohort plugin to use this shape); fallback uses
            // canonical Greenhouse variant-2 form (NOT variant 21 —
            // defensive fallback when wire omits `absolute_url`).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/peloton/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/52 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Peloton: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Peloton scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
