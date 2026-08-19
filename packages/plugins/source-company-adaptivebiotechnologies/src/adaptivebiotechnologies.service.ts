import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Adaptive Biotechnologies Corporation — operator of the
 * **Seattle-HQ commercial immunosequencing platform** built
 * around the immunoSEQ T-cell / B-cell receptor repertoire
 * assay and the clonoSEQ minimal-residual-disease blood test
 * for lymphoid malignancies (NASDAQ: ADPT; founded by Harlan
 * & Chad Robins in 2009 in Seattle, Washington; raised a
 * $300M Series E in 2018; ships the immunoSEQ research
 * platform, the FDA-cleared clonoSEQ assay across the
 * blood-cancer minimal-residual-disease segment, and the
 * T-Detect COVID/Lyme/CMV antigen-mapping diagnostic line —
 * alongside peers Natera, Guardant Health, Exact Sciences,
 * and Veracyte — with FY2024 ATS postings concentrated
 * across the **Laboratory Operations**, **Commercial
 * Operations**, **Diagnostics Clinical Services**,
 * **Diagnostics Sales**, **Digital Health**, **Executive**,
 * **IT Systems & Infrastructure**, **Legal**, **Research and
 * Innovation**, and **Sales & Business Development**
 * delivery verticals across Seattle, WA (HQ), Minneapolis,
 * MN, and Remote/WFH) — publishes its consolidated careers
 * board through Greenhouse at the bare slug
 * `adaptivebiotechnologies` (23 bytes; wire `company_name
 * === 'Adaptive Biotechnologies'` 24 bytes; see Spec 187
 * § 10 D-09).
 *
 * **One structural deviation from the Acurus Solutions
 * (Spec 186) template** — D-04 sub-axis: variant 2
 * (canonical Greenhouse host) → **NEW variant 47** (first
 * cohort observation): HTTPS + `www.`-prefixed truncated-
 * bare-brand `.com` (drop `nologies` from `biotechnologies`
 * → `adaptivebiotech.com` 19-byte domain) + 2-segment
 * `/career-listings/listing` apply-page path **without a
 * trailing slash** + **single-id query** `?gh_jid=<id>`.
 * The **brand-domain-token-truncation** is the novel sub-
 * feature — the slug retains the full `biotechnologies`
 * token (23-byte slug) while the public-facing domain
 * truncates to `biotech` (drop the 9-byte `nologies`
 * suffix). The trim semantics remain unchanged. **Not a
 * re-spin** (structural NEW variant, not a sub-axis shift).
 *
 *   1. **D-04 — NEW wire-shape variant 47 (first cohort
 *      observation).** `https://www.adaptivebiotech.com/career-listings/listing?gh_jid=<id>`
 *      — HTTPS + `www.`-prefixed truncated-bare-brand `.com`
 *      (drop `nologies` from `biotechnologies` → 19-byte
 *      domain `adaptivebiotech.com`) + 2-segment
 *      `/career-listings/listing` apply-page path **without
 *      a trailing slash** + **single-id query**
 *      `?gh_jid=<id>`. The **fiftieth distinct wire-shape
 *      variant** in the company-direct cohort (after Textio
 *      variant 46 at Spec 174). The plugin emits
 *      `listing.absolute_url` byte-for-byte; the fallback
 *      constructor (when the wire omits `absolute_url`)
 *      defaults to canonical Greenhouse variant-2 form
 *      `https://job-boards.greenhouse.io/adaptivebiotechnologies/jobs/<id>`
 *      (same fallback strategy as Textio / Symphony /
 *      Samsara / Klaviyo / Bird / Collective Health /
 *      Netskope). **First cohort observation of brand-
 *      domain-token-truncation** (slug retains full
 *      `biotechnologies` while domain drops `nologies`).
 *      **First cohort observation of no-trailing-slash 2-
 *      segment apply-page path within a NEW-variant D-04
 *      observation**. **First cohort observation of single-
 *      id `?gh_jid=`-only query within a NEW-variant D-04
 *      observation** (Textio variant 46 carried dual-id
 *      `?job=<id>&gh_jid=<id>`).
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *      **One-hundred-and-forty-third** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through (case-symmetric 2-token PascalCase).**
 *      Wire `company_name === 'Adaptive Biotechnologies'`
 *      byte-for-byte (24 bytes — 2-token PascalCase
 *      `'Adaptive'` 8 bytes + `'Biotechnologies'` 15 bytes
 *      + 1 ASCII space; every wire token PascalCase cap-at-
 *      byte-0-only). Slug `adaptivebiotechnologies` 23 bytes
 *      is byte-for-byte the space-strip + lowercase of the
 *      wire (canonical case-symmetric 2-token PascalCase
 *      sub-form). **One-hundred-and-thirty-fourth cohort
 *      plugin to omit D-09.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *      1 of 13 wire titles in the run-397 probe carries
 *      trailing ASCII-space padding (`'Clinical Lab
 *      Technologist II '` — 30-byte payload + 1 trailing
 *      ASCII space). Pad rate ~7.7 % (1/13), trailing-only.
 *      **Eighty-seventh cohort plugin to apply D-10.**
 *
 *   5. **D-11 — fully-clean department pass-through.** 0 of
 *      10 unique wire department names padded
 *      (`'Commercial Operations'`, `'Diagnostics Clinical
 *      Services'`, `'Diagnostics Sales'`, `'Digital
 *      Health'`, `'Executive'`, `'IT Systems &
 *      Infrastructure'`, `'Laboratory Operations'`,
 *      `'Legal'`, `'Research and Innovation'`, `'Sales &
 *      Business Development'`). Pass-through preserves byte-
 *      for-byte. **One-hundred-and-fourteenth cohort plugin**
 *      with fully-clean department pass-through (D-11
 *      omitted).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/adaptivebiotechnologies/jobs';

@SourcePlugin({
  site: Site.ADAPTIVEBIOTECHNOLOGIES,
  name: 'Adaptive Biotechnologies',
  category: 'company',
})
@Injectable()
export class AdaptiveBiotechnologiesService implements IScraper {
  private readonly logger = new Logger(AdaptiveBiotechnologiesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AdaptiveBiotechnologies: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/13 wire titles
        // padded (~7.7 %).
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
        const id = `adaptivebiotechnologies-${jobId}`;

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
            site: Site.ADAPTIVEBIOTECHNOLOGIES,
            title,
            // D-09 pass-through: wire `'Adaptive
            // Biotechnologies'` (2-token PascalCase + 1
            // ASCII space).
            companyName: listing.company_name ?? 'Adaptive Biotechnologies',
            // D-04: wire `absolute_url` flows through (NEW
            // variant 47 — first cohort observation: custom
            // truncated-brand-domain `adaptivebiotech.com`
            // + 2-segment `/career-listings/listing` apply-
            // page path + single-id `?gh_jid=<id>` query).
            // Fallback to canonical variant-2 form when wire
            // omits `absolute_url`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/adaptivebiotechnologies/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/10 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`AdaptiveBiotechnologies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AdaptiveBiotechnologies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
