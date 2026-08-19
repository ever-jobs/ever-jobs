import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Fivetran, Inc. — operator of the dominant managed-data-pipeline
 * ELT platform pioneered around the automated data-replication-
 * and-transformation longitudinal-warehouse data model (founded
 * by George Fraser and Taylor Brown in 2012 in Oakland, CA;
 * raised $728M+ across rounds led by Andreessen Horowitz, General
 * Catalyst, ICONIQ Growth, CEAS Investments, and D1 Capital
 * Partners at a peak $5.6B valuation in 2021; ships an automated
 * data-pipeline + Fivetran HVR enterprise-replication platform
 * across the modern-data-stack segment — alongside competitors
 * Stitch, Airbyte, Hevo Data, Matillion, and Talend — with a
 * hybrid distributed workforce concentrated across Oakland,
 * Denver, Bangalore, Dublin, and Remote across the United States,
 * Europe, and Asia-Pacific) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `fivetran` (the
 * lowercase brand name; case-symmetric with the **trimmed** wire
 * `company_name === 'Fivetran'`; see Spec 082 § 10 D-05). The
 * wire `company_name` carries `'Fivetran '` byte-for-byte (9
 * bytes — the single-token brand name with a single trailing
 * ASCII-space pad byte; 100 % of run-292 wire listings carry
 * the trailing pad). The plugin **trims** the wire before emit
 * so the emitted `companyName` is the 8-byte `'Fivetran'`.
 *
 * **Two structural deviations from the Bitwarden (Spec 079)
 * template:**
 *
 *   1. **D-04 — wire-shape variant 19 (`www.`-prefixed brand-
 *      domain singular `/careers/job` query-only-id).** Fivetran
 *      publishes its `absolute_url` on a **previously-unobserved**
 *      shape `https://www.fivetran.com/careers/job?gh_jid=<id>`
 *      (`www.fivetran.com` — `www.`-prefixed brand-domain;
 *      `/careers/job` SINGULAR path — distinct from variant 13's
 *      `careers/jobs/<id>?gh_jid=<id>` plural-with-id-in-path,
 *      variant 16's `www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
 *      plural-with-duplicate-query, and variant 18's
 *      `bitwarden.com/careers/<id>/?gh_jid=<id>` `<id>`-in-path-
 *      with-trailing-slash-and-query; single `gh_jid` query
 *      parameter — same single-query shape as variants 10, 12,
 *      13, 14, 15, 17, 18). **First** plugin in the cohort to
 *      use **wire-shape variant 19** — the **twenty-second
 *      distinct wire-shape variant** in the company-direct
 *      cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/fivetran/jobs/<id>`
 *      rather than reconstructing the `www.`-prefixed bare-
 *      domain shape (same fallback strategy as ClassPass / Epic
 *      Games / fuboTV / Lattice / Stitch Fix / Udemy / Bitwarden).
 *
 *   2. **D-09 APPLIED for the first time in cohort history.**
 *      Wire `company_name === 'Fivetran '` byte-for-byte (9
 *      bytes — single trailing ASCII-space pad). The slug
 *      `fivetran` is 8 bytes — slug/wire-asymmetric, wire LONGER
 *      than slug by 1 byte (the trailing pad). **All 173 of 173
 *      wire `company_name` values in the run-292 probe carry the
 *      trailing pad** (100 % pad rate) — this is a systematic
 *      upstream pattern, not a one-off typo. The plugin applies
 *      `.trim()` to `listing.company_name` before emit so the
 *      emitted `companyName` is the 8-byte `'Fivetran'`.
 *
 *      **First cohort plugin to APPLY D-09** — opening a brand-
 *      new sub-axis under D-09 alongside the existing thirty-one
 *      D-09 omission cases. Distinct from prior slug/wire
 *      asymmetry cases which all preserved the wire byte-for-
 *      byte (Honeycomb wire 12 bytes vs slug 9 bytes — TLD
 *      suffix preserved; MasterClass wire 11 bytes vs slug 11
 *      bytes — case difference preserved; Maven Clinic wire 12
 *      bytes vs slug 11 bytes — internal space preserved;
 *      Stitch Fix wire 10 bytes vs slug 9 bytes — internal space
 *      preserved). Fivetran is the first cohort case where the
 *      slug/wire asymmetry is **noise (whitespace pad) rather
 *      than signal (TLD / case / internal-space)** — so the
 *      plugin trims rather than preserving.
 *
 *      Analogous to Lattice's first-cohort D-11 application at
 *      run #284 (trailing-space pad on department) and DataCamp's
 *      first-cohort D-11 leading-pad observation at run #291 —
 *      all three use the standard `String.prototype.trim()`
 *      semantic, just on different axes.
 *
 * Shared with Bitwarden:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Fivetran's
 *     `content` is HTML-entity-encoded (`&lt;div class=&quot;
 *     content-intro&quot;&gt;&lt;p&gt;From Fivetran's founding
 *     until now, our mission has remained the same: to make
 *     access to data as simple and reliable as electricity...`),
 *     so the plugin decodes entities BEFORE stripping tags.
 *     **Thirty-eighth** plugin in the cohort to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 173 wire
 *     titles in the run-292 probe carry whitespace padding (the
 *     wire is fully clean). The plugin emits `listing.title`
 *     byte-for-byte without a `.trim()`. **Fourteenth cohort
 *     plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** Fivetran's
 *     wire department names are 0 of 172 populated padded (0 %
 *     pad rate — `'Engineering Department'`, `'Sales
 *     Department'`, `'Marketing Department'`, etc. — the
 *     `' Department'` suffix is structural data shape, not pad
 *     bytes). The plugin emits the wire `departments[0].name`
 *     byte-for-byte without a `.trim()`. **Twenty-eighth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fivetran/jobs';

@SourcePlugin({
  site: Site.FIVETRAN,
  name: 'Fivetran',
  category: 'company',
})
@Injectable()
export class FivetranService implements IScraper {
  private readonly logger = new Logger(FivetranService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Fivetran: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/173 wire titles padded in run-292 probe;
        // pass through byte-for-byte.
        const title = listing.title ?? '';
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
        const id = `fivetran-${jobId}`;

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
            site: Site.FIVETRAN,
            title,
            // D-09 APPLIED (first cohort): trim wire `company_name`
            // before emit. Wire is `'Fivetran '` (9 bytes — single
            // trailing ASCII-space pad on 100 % of run-292
            // listings). Trim strips the pad so emitted form is
            // the 8-byte `'Fivetran'`. Defensive fallback is also
            // pre-trimmed `'Fivetran'`. **First cohort plugin to
            // apply D-09** — opening a new sub-axis alongside the
            // existing thirty-one D-09 omission cases.
            companyName: (listing.company_name ?? 'Fivetran').trim(),
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-19 `www.`-
            // prefixed brand-domain singular `/careers/job`
            // query-only-id shape
            // `www.fivetran.com/careers/job?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the bare-domain shape, because
            // the fallback can only produce a guaranteed-
            // resolvable URL using the Greenhouse subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fivetran/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/172 populated wire department names
            // padded in run-292 probe; pass through byte-for-byte.
            // The `' Department'` suffix in the wire is structural
            // data, not pad bytes — preserved as-is.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Fivetran: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Fivetran scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
