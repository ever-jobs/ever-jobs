import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Fastly, Inc. — operator of the **dominant edge-cloud platform
 * pioneered around the programmable-CDN / Compute@Edge / image-
 * optimization / DDoS-protection data model** (founded by Artur
 * Bergman in 2011 in San Francisco; public on the NYSE since
 * May 2019 IPO under ticker `FSLY` at a $2.6B initial
 * valuation; ships Fastly's globally-distributed edge network
 * (Compute@Edge, Image Optimization, Cloud Security, Bot
 * Management, DDoS Protection, Next-Gen WAF) across the edge-
 * cloud / CDN / web-performance segment — alongside competitors
 * Cloudflare, Akamai, AWS CloudFront, and AT&T Edgecast — with
 * a hybrid distributed workforce concentrated across San
 * Francisco (HQ), Denver, New York, Pune (India), London, and
 * Remote across the United States, India, the United Kingdom,
 * the European Union, and the Asia-Pacific region) — publishes
 * its consolidated careers board through Greenhouse at the bare
 * slug `fastly` (the lowercase brand-name; case-symmetric with
 * the wire `company_name === 'Fastly'`; see Spec 113 § 10
 * D-05).
 *
 * **One structural deviation from the Squarespace (Spec 088)
 * template** — D-04 wire-shape variant 30 (first cohort plugin
 * to use variant 30; **first cohort observation of HTTPS-scheme
 * `/about/jobs/apply` query-only-id**). Variant 30 is the HTTPS
 * sister to Squarespace's variant 22 (HTTP `/about/careers`).
 * All other axes share with Squarespace: D-08 entity-decode-
 * then-tag-strip, D-09 omitted with case-symmetric bare-brand
 * wire, D-10 applied (Fastly 1/64 padded ~1.6 % — second-lowest
 * D-10 pad rate observed in cohort), D-11 omitted (departments
 * fully clean).
 *
 *   1. **D-04 — wire-shape variant 30 (HTTPS-scheme `www.`-
 *      prefixed brand-domain `/about/jobs/apply` query-only-id —
 *      first cohort observation).** Fastly publishes its
 *      `absolute_url` on a **previously-unobserved** shape
 *      `https://www.fastly.com/about/jobs/apply?gh_jid=<id>`
 *      with three sub-axes:
 *      a) **HTTPS scheme** (HTTPS sister to Squarespace's
 *         variant 22 HTTP `/about/careers` — restoring HTTPS
 *         while keeping the `/about/`-ancestor pattern).
 *      b) **`www.`-prefixed brand-domain** — same `www.` prefix
 *         as variants 16 (Stitch Fix), 19 (Fivetran), 20
 *         (Lookout), 22 (Squarespace).
 *      c) **`/about/jobs/apply` path** — distinct from variant
 *         22's `/about/careers`; the `/about/jobs/<leaf>` form
 *         with a `/jobs/` mid-segment + `/apply` leaf is the
 *         **first cohort observation** of this combination.
 *      Single `gh_jid` query parameter. **First** plugin in the
 *      cohort to use **wire-shape variant 30** — the **thirty-
 *      third distinct wire-shape variant** in the company-direct
 *      cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/fastly/jobs/<id>`.
 *
 * Shared with Squarespace:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Fastly'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte slug
 *     `fastly`). **Sixtieth cohort plugin to omit D-09 — crosses
 *     the 60-plugin D-09-omission threshold at this run**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 64 wire titles in the run-323 probe carries trailing
 *     ASCII-space padding (~1.6 % pad rate; second-lowest D-10
 *     pad rate observed in cohort, just behind Braze's ~1.4 %).
 *     **Thirty-seventh cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 64
 *     wire department names padded across 28 unique departments
 *     (`'Sales Engineering'`, `'Cloud Engineering - COR'`,
 *     `'Customer Security - CSOC'`, `'CFO'`, `'Infrastructure
 *     Engineering'`, `'Finance Systems'`, `'Information
 *     Technology'`, `'Human Resources'`, `'Solution
 *     Engineering'`, plus 19 others — clean multi-token forms
 *     with internal whitespace, hyphens, and acronym suffixes).
 *     **Fifty-fourth cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fastly/jobs';

@SourcePlugin({
  site: Site.FASTLY,
  name: 'Fastly',
  category: 'company',
})
@Injectable()
export class FastlyService implements IScraper {
  private readonly logger = new Logger(FastlyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Fastly: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/64 wire titles
        // padded (~1.6 %).
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
        const id = `fastly-${jobId}`;

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
            site: Site.FASTLY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Fastly',
            // D-04: wire `absolute_url` flows through (variant 30
            // — HTTPS `www.fastly.com/about/jobs/apply?gh_jid=`).
            // Fallback uses canonical Greenhouse variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fastly/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/64 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Fastly: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Fastly scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
