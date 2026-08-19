import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Coalition, Inc. — operator of the **dominant Active Cyber
 * Insurance platform pioneered around the cyber-risk-monitoring +
 * insurance-underwriting + incident-response data model**
 * (founded by Joshua Motta and John Hering in 2017 in San
 * Francisco; raised ~$755M across rounds at peak ~$5B valuation
 * in July 2022 led by Allianz X / Valor Equity Partners; ships
 * the Coalition Risk Management Platform alongside cyber + tech-
 * E&O insurance underwriting and the in-house Coalition Incident
 * Response (CIR) practice across the cyber-insurance / cyber-
 * security segment — alongside competitors At-Bay, Resilience,
 * Corvus Insurance (acquired by Travelers 2024), Cowbell, and
 * Beazley — with a hybrid distributed workforce concentrated
 * across San Francisco (HQ), New York, Toronto, London, and
 * Remote across the United States, Canada, the UK, and the EU)
 * — publishes its consolidated careers board through Greenhouse
 * at the bare slug `coalition` (the lowercase brand-stem; **slug-
 * vs-wire-vs-domain TRI-AXIS divergence** — see Spec 095 § 10
 * D-05: slug `coalition` (9 bytes, lowercase, brand-stem only)
 * vs wire `'Coalition, Inc.'` (15 bytes, includes legal-entity
 * suffix `, Inc.`) vs domain `coalitioninc.com` (16 bytes, slug-
 * divergent vanity with concatenated TLD-stem like billcom)).
 *
 * **Three structural deviations from the BILL (Spec 092)
 * template** — D-04 wire-shape variant 25 (NEW — first cohort
 * plugin to use variant 25; www-prefixed slug-divergent vanity
 * domain `coalitioninc.com` + root-level `/job-posting` +
 * single `gh_jid` query); D-09 omitted with **legal-entity
 * comma-suffix wire form** (first cohort observation of
 * `'<Brand>, Inc.'` legal-name wire — distinct from prior
 * 42 cohort plugins which all carried bare-brand wire forms);
 * D-10 applied with **leading-double-space pad sub-axis** (1 of
 * 19 wire titles `'  Senior Incident Response Analyst'` —
 * first cohort observation of leading-multi-byte-ASCII-space
 * pad-byte run; Scopely's run-297 multi-byte trailing was the
 * trailing equivalent).
 *
 *   1. **D-04 — wire-shape variant 25 (www-prefixed slug-
 *      divergent vanity `/job-posting` single-id query —
 *      first cohort observation).** Coalition publishes
 *      `absolute_url` on
 *      `https://www.coalitioninc.com/job-posting?gh_jid=<id>`
 *      with three distinguishing sub-axes:
 *      a) **`www.`-prefixed brand-domain `www.coalitioninc.com`**
 *         — same prefix sub-axis as variants 16/19/20/24;
 *         distinct from variants 13/15/18/23 which use the
 *         bare brand-domain.
 *      b) **Slug-divergent vanity** — slug `coalition` is the
 *         9-byte lowercase brand-stem, but the customer-facing
 *         domain `coalitioninc.com` concatenates the legal-
 *         entity suffix `inc` AND the TLD-stem `.com`. Same
 *         slug-vs-domain TLD-stem elision/re-insertion sub-axis
 *         as variant 24 (BILL — slug `billcom` vs domain
 *         `bill.com`). **Second** cohort observation of slug-
 *         divergent vanity domain.
 *      c) **Root-level `/job-posting` (singular hyphenated)
 *         single-id query `?gh_jid=<id>`** — same path-segment
 *         shape as variant 23 (Benevity's `/job-posting`); same
 *         single-id query as variants 13/15/18/19/20/23.
 *         Distinct from variant 24's bare `/job` + dual-id query.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 25** — the **twenty-eighth distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/coalition/jobs/<id>`.
 *
 *   2. **D-09 — brand-name trim omitted with FIRST-COHORT
 *      legal-entity comma-suffix wire form `'Coalition, Inc.'`.**
 *      Wire `company_name === 'Coalition, Inc.'` byte-for-byte
 *      (15 bytes — fully clean; 0 of 19 padded). The wire
 *      includes the **comma-space-`Inc.`** legal-entity suffix
 *      — the **first cohort observation** of a wire
 *      `company_name` that carries an embedded legal-entity
 *      suffix. All prior 42 cohort plugins carried bare-brand
 *      wire forms (e.g. `'Cerebral'`, `'Bobbie'`, `'Adyen'`,
 *      `'BILL'`, `'Coursera'`) and noted in their per-plugin
 *      docstrings that the legal-entity name was distinct from
 *      the wire (e.g. `"Cerebral, Inc."`, `"Bobbie, Inc."`).
 *      Coalition reverses this convention: the wire IS the
 *      legal name. The plugin emits the wire byte-for-byte
 *      (preserving `'Coalition, Inc.'`) with a defensive
 *      `'Coalition, Inc.'` fallback. Downstream cross-source
 *      dedup (if used) is responsible for canonicalising the
 *      legal-entity-vs-bare-brand axis. **Forty-fourth cohort
 *      plugin to omit D-09**, **first** with embedded legal-
 *      entity suffix.
 *
 *   3. **D-10 — wire-title `.trim()` applied (leading-double-
 *      space form — first cohort observation of leading-multi-
 *      byte-ASCII-space pad-byte run).** 1 of 19 wire titles in
 *      the run-305 probe carries a **leading-double-ASCII-space**
 *      pad (`'  Senior Incident Response Analyst'` — 2 leading
 *      ASCII spaces; ~5.3 % pad rate). All prior leading-pad
 *      D-10 observations (DataCamp, New Relic, Scopely's dual-
 *      pad cases) were single-leading-space; Scopely's run-297
 *      multi-byte trailing observation surfaced the trailing
 *      equivalent. Coalition is the **first** cohort plugin to
 *      observe a **leading-multi-byte-ASCII-space pad-byte run**
 *      under D-10. Standard `String.prototype.trim()` strips
 *      arbitrary-length leading/trailing whitespace runs in a
 *      single call — no implementation change vs peers. **Twenty-
 *      second cohort plugin to apply D-10**.
 *
 * Shared with BILL:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-first** plugin to apply D-08.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 19
 *     wire department names padded (`'Claims'`, `'Customer
 *     Success'`, `'Data'`, `'Engineering'`, `'Incident Response
 *     (CIR)'`, `'Legal'`, `'Security Engineering'`, `'Security
 *     Sales'` — clean multi-token forms with parenthesised
 *     initialism). **Thirty-ninth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/coalition/jobs';

@SourcePlugin({
  site: Site.COALITION,
  name: 'Coalition',
  category: 'company',
})
@Injectable()
export class CoalitionService implements IScraper {
  private readonly logger = new Logger(CoalitionService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Coalition: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (leading-double-space form — first cohort
        // observation of leading-multi-byte-ASCII-space pad-byte
        // run under D-10). Standard `trim()` strips arbitrary-
        // length leading/trailing whitespace.
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
        const id = `coalition-${jobId}`;

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
            site: Site.COALITION,
            title,
            // D-09 omitted with first-cohort legal-entity comma-
            // suffix wire form `'Coalition, Inc.'`. Wire bytes
            // flow through; defensive fallback preserves the
            // same legal-entity form.
            companyName: listing.company_name ?? 'Coalition, Inc.',
            // D-04: wire `absolute_url` flows through (variant 25
            // — www-prefixed slug-divergent vanity domain
            // `coalitioninc.com` + root-level `/job-posting` +
            // single `gh_jid` query); fallback uses canonical
            // Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/coalition/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/19 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Coalition: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Coalition scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
