import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * BILL Holdings, Inc. — Nasdaq-listed (BILL) financial-operations
 * SaaS platform pioneered around the SMB AP/AR-automation,
 * spend-and-expense, and integrated-payments stack (founded by
 * René Lacerte in 2006 as Bill.com Holdings; rebranded to "BILL"
 * in 2022; acquired Divvy in 2021 and Invoice2go in 2021;
 * headquartered in San Jose with a major Draper, Utah hub) —
 * publishes its consolidated careers board through Greenhouse at
 * the bare slug `billcom` (the lowercase no-dot brand-stem; the
 * wire `company_name === 'BILL'` is the post-rebrand all-caps
 * brand — see Spec 092 § 10 D-05 for the slug-vs-brand-vs-domain
 * tri-axis: slug `billcom` / brand `'BILL'` / domain `bill.com`).
 *
 * **Three structural deviations from the Benevity (Spec 091)
 * template** — D-04 wire-shape variant 24 (NEW — first cohort
 * plugin to use variant 24; www-prefixed slug-divergent vanity
 * domain `bill.com` + root-level `/job` + DUAL-id query
 * `?<id>&gh_jid=<id>`); D-10 applied (2 of 46 padded — first
 * tab-prefix observation in cohort); D-11 applied (18 of 46
 * padded with single-trailing-space form — first cohort
 * observation of a high-pad-rate D-11 application at ~39 %).
 *
 *   1. **D-04 — wire-shape variant 24 (www-prefixed slug-
 *      divergent vanity domain `/job` dual-id-query — first
 *      cohort observation).** BILL publishes its
 *      `absolute_url` on a previously-unobserved shape
 *      `https://www.bill.com/job?<id>&gh_jid=<id>` with four
 *      distinguishing sub-axes:
 *      a) **`www.`-prefixed brand-domain `www.bill.com`** —
 *         same prefix sub-axis as variants 16 (Webflow), 19
 *         (Klaviyo), 20 (Lookout); distinct from variants 13/15/
 *         18/23 which use bare brand-domain.
 *      b) **Slug-divergent vanity** — the careers slug
 *         `billcom` is the no-dot brand-stem, but the customer-
 *         facing domain `bill.com` drops the `com` suffix and
 *         re-introduces a dot. First cohort observation of a
 *         slug-vs-domain elision/re-insertion of the TLD-stem
 *         within the brand-name.
 *      c) **Root-level `/job` (singular, no hyphen)** — same
 *         singular root-level positioning as variant 15
 *         (Lattice's bare `/job`); distinct from variant 23
 *         (Benevity's `/job-posting` hyphenated singular) and
 *         variant 20 (Lookout's `/careers/job-post`).
 *      d) **Dual-id query `?<id>&gh_jid=<id>`** — first cohort
 *         observation of a query format that emits the listing
 *         ID as both the bare leading query token AND as the
 *         `gh_jid=` parameter value. All other cohort plugins
 *         use either `?gh_jid=<id>` (single canonical) or a
 *         path-only id segment.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 24** — the **twenty-seventh distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/billcom/jobs/<id>`.
 *
 *   2. **D-10 — wire-title `.trim()` applied (mixed-pad form —
 *      first cohort observation of `\t` tab-prefix).** BILL's
 *      run-302 probe carries 2 of 46 wire titles with whitespace
 *      padding (~4.3 %), but with a previously-unobserved sub-
 *      axis: one trailing-space pad (`'Associate Fraud Strategy
 *      Data Scientist '`) and one **leading TAB pad**
 *      (`'\tSenior Product Manager - Developer Ecosystem &
 *      Partner Platform'`). All prior D-10 applications
 *      (Brex, Buildkite, ZoomInfo, Attentive, Elastic, Intercom,
 *      Mixpanel, Faire, Carta, ClassPass, Epic Games, Flexport,
 *      fuboTV, Glossier, Honeycomb, Maven Clinic, Stitch Fix,
 *      Adyen) involve only ASCII-space pad bytes (single
 *      leading or trailing). BILL is the **first** cohort
 *      plugin to observe a `\t` tab-character pad-byte under
 *      D-10. The plugin uses the standard
 *      `String.prototype.trim()` (which strips ALL Unicode
 *      whitespace including `\t`, so the implementation is
 *      identical to peers — only the wire-pad axis is novel).
 *      **Twentieth cohort plugin to apply D-10**.
 *
 *   3. **D-11 — wire-department `.trim()` applied (high-pad-
 *      rate trailing-space form — first cohort observation at
 *      ~39 %).** BILL's run-302 probe carries 18 of 46 wire
 *      department-name records with single-trailing-space
 *      padding (`'Engineering '`, `'Marketing '`, etc.) — a
 *      ~39.1 % listing-level pad rate that is the **highest
 *      D-11 pad-rate observed** in the cohort (prior
 *      applications: Lattice trailing, DataCamp leading,
 *      Typeform trailing — all at ~10–14 % rates). The plugin
 *      trims BEFORE the searchTerm guard so case-insensitive
 *      department matches honour the trimmed form.
 *      **Fourth cohort plugin to apply D-11** (after Lattice's
 *      run-284 first-ever trailing-pad, DataCamp's run-291
 *      first-ever leading-pad, and Typeform's run-299 second
 *      trailing-pad).
 *
 * Shared with Benevity:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-asymmetric all-
 *     caps).** Wire `company_name === 'BILL'` byte-for-byte
 *     (4 bytes — fully clean; 0 of 46 padded). Note the
 *     case-asymmetry vs the lowercase 6-byte slug `billcom`
 *     (different byte-length, different case, different stem-
 *     structure). The plugin emits the wire byte-for-byte with
 *     a defensive `'BILL'` fallback. **Forty-first cohort
 *     plugin to omit D-09**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/billcom/jobs';

@SourcePlugin({
  site: Site.BILLCOM,
  name: 'BILL',
  category: 'company',
})
@Injectable()
export class BillcomService implements IScraper {
  private readonly logger = new Logger(BillcomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BILL: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed-pad — first cohort observation of
        // tab-prefix pad-byte): 2 of 46 wire titles in run #302
        // padded — one trailing-space, one leading-tab. Standard
        // `trim()` strips both forms.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (high-pad-rate trailing-space form): 18 of
        // 46 wire departments in run #302 carry single-trailing-
        // space padding (`'Engineering '`, `'Marketing '`, etc.).
        // Trim BEFORE the searchTerm guard so case-insensitive
        // department matches honour the trimmed form.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `billcom-${jobId}`;

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
            site: Site.BILLCOM,
            title,
            // D-09 omitted: case-asymmetric all-caps wire form
            // `company_name === 'BILL'` byte-for-byte (4 bytes).
            companyName: listing.company_name ?? 'BILL',
            // D-04: wire `absolute_url` flows through (variant 24
            // — www-prefixed slug-divergent vanity `bill.com`,
            // root-level `/job`, dual-id query); fallback uses
            // canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/billcom/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (trailing-space form): trimmed wire
            // department; the wire pad bytes (18 of 46 listings)
            // are stripped before emit.
            department,
          }),
        );
      }

      this.logger.log(`BILL: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BILL scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
