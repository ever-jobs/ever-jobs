import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Squarespace, Inc. — operator of the dominant all-in-one
 * website-builder + ecommerce / scheduling / domains platform
 * pioneered around the templated-CMS-and-domain-registrar data
 * model (founded by Anthony Casalena in 2003 in New York City;
 * IPO'd on NYSE as `SQSP` in May 2021 via direct listing; ships
 * a unified subscription product spanning website-builder,
 * ecommerce storefront, Acuity-Scheduling appointment-booking,
 * and domain-registrar across the SMB-website segment —
 * alongside competitors Wix, Shopify, Weebly, GoDaddy, and
 * WordPress.com — with a hybrid distributed workforce
 * concentrated across New York City, Dublin, Portland OR, and
 * Remote across the United States, Ireland, and the United
 * Kingdom) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `squarespace` (the lowercase
 * brand name; case-symmetric with the wire `company_name ===
 * 'Squarespace'`; see Spec 088 § 10 D-05).
 *
 * **One structural deviation from the Marqeta (Spec 084)
 * template** — D-04 wire-shape variant 22 (first cohort plugin
 * to use variant 22; **first cohort observation of HTTP scheme**
 * in the wire URL — every prior cohort variant uses HTTPS).
 * All other axes share with Marqeta: D-08 entity-decode-then-
 * tag-strip, D-09 omitted with case-symmetric bare-brand wire,
 * D-10 applied (Squarespace 9/36 padded ~25 %; Marqeta 2/33
 * padded ~6.1 %), D-11 omitted (departments fully clean).
 *
 *   1. **D-04 — wire-shape variant 22 (HTTP-scheme `www.`-
 *      prefixed brand-domain `/about/careers` query-only-id —
 *      first cohort observation of HTTP scheme).** Squarespace
 *      publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `http://www.squarespace.com/about/careers?gh_jid=<id>`
 *      with three new sub-axes:
 *      a) **HTTP scheme** (not HTTPS) — distinct from every
 *         prior cohort variant which all use HTTPS. The
 *         `http://` scheme is not a security concern (HSTS
 *         preload auto-upgrades in all modern browsers) but is
 *         a wire-side anomaly worth capturing. **First cohort
 *         observation of HTTP scheme** in the wire URL.
 *      b) **`www.`-prefixed brand-domain** — same `www.` prefix
 *         as variants 16 (Stitch Fix), 19 (Fivetran), 20
 *         (Lookout).
 *      c) **`/about/careers` path** — distinct from variant
 *         19's singular `/careers/job` and variant 20's
 *         `/careers/job-post`; the `/about/` segment prefix is
 *         a marketing-page ancestor distinct from prior cohort
 *         variants.
 *      Single `gh_jid` query parameter. **First** plugin in the
 *      cohort to use **wire-shape variant 22** — the **twenty-
 *      fifth distinct wire-shape variant** in the company-direct
 *      cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte
 *      including the `http://` scheme. The **fallback** `jobUrl`
 *      constructor defaults to the canonical Greenhouse
 *      **variant-2** form
 *      `https://job-boards.greenhouse.io/squarespace/jobs/<id>`
 *      (HTTPS) — same fallback strategy as ClassPass / Epic
 *      Games / fuboTV / Lattice / Stitch Fix / Udemy /
 *      Bitwarden / Fivetran / Lookout / Peloton.
 *
 * Shared with Marqeta:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Squarespace'` byte-for-byte (11 bytes
 *     — fully clean, case-symmetric with the lowercase slug).
 *     **Thirty-seventh cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 9 of 36 wire
 *     titles in the run-298 probe carry trailing ASCII-space
 *     padding (~25 % pad rate; e.g. `'Connections & Community
 *     Lead '`, `'Lead FP&A Analyst, Consolidations '`,
 *     `'Manager, Detection & Incident Response '`). All
 *     trailing-only. **Twenty-fourth cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 36
 *     wire department names padded (`'Engineering (Domains &
 *     Apps)'`, `'People'`, `'Finance'`, `'Domains &
 *     Applications'`, `'Legal & Communications'`,
 *     `'Engineering'`, `'Product'`, `'Customer Operations'` —
 *     clean multi-token forms with internal whitespace,
 *     ampersands, and parentheses). **Thirty-fourth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/squarespace/jobs';

@SourcePlugin({
  site: Site.SQUARESPACE,
  name: 'Squarespace',
  category: 'company',
})
@Injectable()
export class SquarespaceService implements IScraper {
  private readonly logger = new Logger(SquarespaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Squarespace: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 9/36 padded in run-298 probe.
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
        const id = `squarespace-${jobId}`;

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
            site: Site.SQUARESPACE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Squarespace',
            // D-04: wire `absolute_url` flows through (variant 22
            // — HTTP scheme preserved byte-for-byte). Fallback
            // uses canonical Greenhouse variant-2 form (HTTPS).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/squarespace/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/36 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Squarespace: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Squarespace scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
