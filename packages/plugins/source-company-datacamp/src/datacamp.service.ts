import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * DataCamp — operator of the dominant data-and-AI-skills online-
 * learning platform pioneered around the in-browser interactive-
 * coding-exercise data model (founded by Jonathan Cornelissen,
 * Dieter De Mesmaeker, and Martijn Theuwissen in 2013 in Leuven,
 * Belgium; raised $30M+ across rounds led by Spectrum Equity,
 * Accomplice, and Arthur Ventures; ships a hybrid B2C
 * interactive-coding-tutorial subscription + B2B DataCamp for
 * Business enterprise-skill-tracking platform across the
 * lifelong-learning segment — alongside competitors Coursera,
 * Udemy, Pluralsight, edX, and Codecademy — with a hybrid
 * distributed workforce concentrated across Belgium, the
 * Netherlands, the United Kingdom, and Remote EU/US) — publishes
 * its consolidated careers board through Greenhouse at the bare
 * lowercase concatenated slug `datacamp` (case-asymmetric with
 * the wire `company_name === 'DataCamp'` which carries the
 * brand's CamelCase form; see Spec 081 § 10 D-05). The wire
 * `company_name` is the literal CamelCase brand string
 * `'DataCamp'` byte-for-byte (8 bytes; same byte-count as the
 * lowercase slug `datacamp` but byte-distinct via case at byte
 * index 4 — `C` vs `c`).
 *
 * **One structural deviation** from the MasterClass (Spec 075)
 * template — D-11 **applied** with leading-space-pad form
 * (DataCamp 1/41 padded with single-leading-space `' IT'`;
 * MasterClass 0/6 padded — fully-clean department pass-
 * through). All other axes share with MasterClass: D-04
 * wire-shape variant 2 (canonical Greenhouse host), D-08
 * entity-decode-then-tag-strip, D-09 omitted with case-only
 * asymmetry, D-10 omitted (both 0/N padded). DataCamp is the
 * **second cohort plugin** with case-only slug/wire asymmetry
 * — proving out the MasterClass shape is a recurring axis.
 * **Distinct deviation axis from Lattice's first D-11
 * application**: DataCamp leading-space vs Lattice trailing-
 * space; both handled by the same `String.prototype.trim()`
 * semantic.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse
 *      host).** DataCamp's tenant publishes its `absolute_url`
 *      on the canonical Greenhouse variant-2 shape
 *      `https://job-boards.greenhouse.io/datacamp/jobs/<id>` —
 *      the baseline shape used by the majority of cohort
 *      plugins from Klaviyo onwards. **Twenty-first cohort
 *      plugin** to use canonical variant 2 (extending the
 *      baseline streak after Calendly's Spec 080 return-to-
 *      baseline observation following Bitwarden's variant-18
 *      first-cohort observation in Spec 079).
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor (when Greenhouse
 *      omits `absolute_url`) reconstructs the same canonical
 *      variant-2 form `https://job-boards.greenhouse.io/datacamp/jobs/<id>`
 *      (deterministic given the listing ID — no defence-in-
 *      depth divergence between wire and fallback).
 *
 *   2. **D-08 — entity-decode-then-tag-strip description
 *      pipeline.** Like every plugin from Klaviyo onwards,
 *      DataCamp's `content` is HTML-entity-encoded
 *      (`&lt;p&gt;&lt;strong&gt;About DataCamp&lt;/strong&gt;
 *      &lt;/p&gt;`), so the plugin decodes entities BEFORE
 *      stripping tags. **Thirty-seventh** plugin in the cohort
 *      to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-only
 *      asymmetry).** Wire `company_name === 'DataCamp'` byte-
 *      for-byte (8 bytes; PascalCase). Slug `datacamp` is also
 *      8 bytes — slug/wire EQUAL-byte-length but byte-distinct
 *      via case alone at byte index 4. Same shape as
 *      MasterClass (Spec 075 § 10 D-09 — slug `masterclass` /
 *      wire `'MasterClass'`). The plugin reads
 *      `listing.company_name` directly with `'DataCamp'` as a
 *      defensive fallback. **Thirty-first cohort plugin to omit
 *      D-09**, but the **eighth slug/wire asymmetry case
 *      overall** (after Ramp Network, Scale AI, fuboTV,
 *      Honeycomb, MasterClass, Maven Clinic, and Stitch Fix);
 *      and the **second** equal-length-case-only asymmetry
 *      case after MasterClass.
 *
 *   4. **D-10 — wire-title `.trim()` omitted (no observed
 *      pad).** DataCamp's wire titles are 0 of 41 padded
 *      (~0 % pad rate — fully clean) in the run-291 probe. The
 *      plugin emits `listing.title` byte-for-byte without a
 *      `.trim()` (the pass-through preserves byte-fidelity to
 *      the wire shape; if DataCamp introduces title padding
 *      upstream, the byte-for-byte assertion in the unit-test
 *      happy path catches the diff). **Thirteenth cohort plugin
 *      to omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` applied (leading-
 *      pad form — first cohort observation).** DataCamp's wire
 *      department names are 1 of 41 padded with **leading**
 *      ASCII space (`' IT'` — the `' IT'` 3-byte form trims to
 *      the 2-byte `'IT'`; ~2.4 % overall pad rate). The plugin
 *      applies `.trim()` to the wire `departments[0].name`
 *      before downstream filters and emit. **Second cohort
 *      plugin to apply D-11** (after Lattice in Spec 074 with
 *      a trailing-pad form); **first** cohort plugin to apply
 *      D-11 with a **leading-pad** form — opening the leading-
 *      pad sub-axis under D-11.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/datacamp/jobs';

@SourcePlugin({
  site: Site.DATACAMP,
  name: 'DataCamp',
  category: 'company',
})
@Injectable()
export class DatacampService implements IScraper {
  private readonly logger = new Logger(DatacampService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`DataCamp: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted (no pad observed — 0/41 in run #291): emit
        // wire title byte-for-byte without `.trim()`.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied (leading-pad form — first cohort observation):
        // 1 of 41 wire departments in run #291 carries a single-
        // leading ASCII space (`' IT'` → `'IT'`). The plugin trims
        // BEFORE the searchTerm guard so case-insensitive department
        // matches honour the trimmed form.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `datacamp-${jobId}`;

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
            site: Site.DATACAMP,
            title,
            // D-09 omitted: case-only asymmetric wire form
            // `company_name === 'DataCamp'` byte-for-byte
            // (8 bytes; PascalCase brand; same byte count as the
            // lowercase 8-byte slug `datacamp` but byte-distinct
            // via case alone at byte index 4); pass-through with
            // a defensive `'DataCamp'` fallback.
            companyName: listing.company_name ?? 'DataCamp',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the canonical variant-2
            // shape `job-boards.greenhouse.io/datacamp/jobs/<id>`).
            // Fallback reconstructs the same canonical variant-2
            // form (deterministic given the listing ID).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/datacamp/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (leading-pad form): trimmed wire
            // department; the wire pad bytes (1 of 41 listings
            // have a leading-space pad — `' IT'`) are stripped
            // before emit.
            department,
          }),
        );
      }

      this.logger.log(`DataCamp: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`DataCamp scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
