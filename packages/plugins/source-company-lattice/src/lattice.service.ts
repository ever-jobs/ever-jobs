import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Lattice — operator of the dominant continuous-performance-
 * management and HR-software platform pioneered around the
 * employee-engagement, OKR-tracking, growth-and-feedback data
 * model (founded by Jack Altman and Eric Koslow in 2015 in San
 * Francisco; raised $328M+ across rounds led by Tiger Global,
 * Founders Fund, Y Combinator, Khosla Ventures, and Thrive Capital
 * at a peak $3B valuation in 2022; ships an HRIS / performance /
 * engagement / growth / compensation suite across the
 * people-management segment alongside competitors Workday,
 * BambooHR, Culture Amp, 15Five, and Leapsome, with a remote-first
 * workforce concentrated across the United States, Canada, and the
 * United Kingdom) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `lattice` (the lowercase
 * brand name; symmetric case-insensitively with the wire
 * `company_name === 'Lattice'`; see Spec 074 § 10 D-05). The wire
 * `company_name` is the single-token bare brand `'Lattice'`
 * byte-for-byte (7 bytes; slug `lattice` is 7 bytes — slug-
 * symmetric case-insensitively).
 *
 * **Three structural deviations from the Honeycomb (Spec 073)
 * template:**
 *
 *   1. **D-04 — wire-shape variant 15 (bare brand-domain
 *      singular-`/job` query-only-id).** Lattice's tenant
 *      publishes its `absolute_url` on a **previously-unobserved
 *      bare brand-domain shape**
 *      `https://lattice.com/job?gh_jid=<id>` (bare `lattice.com`
 *      rather than `www.lattice.com` or any vanity subdomain like
 *      `careers.lattice.com`; **`/job`** singular fixed path —
 *      distinct from variant 13's `careers/jobs/<id>?gh_jid=<id>`
 *      shape; the listing ID appears **only** in the `gh_jid`
 *      query parameter, not in the path — distinct from variant
 *      14's `careers.fubo.tv/fubotv-job-openings/?gh_jid=<id>`
 *      vanity-subdomain shape). This is the **first** plugin in
 *      the cohort to use **wire-shape variant 15** — the
 *      **eighteenth distinct wire-shape variant** in the company-
 *      direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination. The **fallback**
 *      `jobUrl` constructor (when Greenhouse omits `absolute_url`
 *      — a defence-in-depth path Greenhouse has not exercised
 *      against this tenant in the audit window) defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/lattice/jobs/<id>` rather
 *      than reconstructing the bare-domain shape, because the
 *      bare-domain shape requires `lattice.com`-side proxying that
 *      may not be guaranteed for all listing IDs (same fallback
 *      strategy as ClassPass — Spec 067 § 10 D-04 — Epic Games —
 *      Spec 069 § 10 D-04 — and fuboTV — Spec 071 § 10 D-04).
 *
 *   2. **D-10 — wire-title `.trim()` omitted.** 0 of 11 wire titles
 *      in the run-284 probe carry whitespace padding (the wire is
 *      fully clean). The plugin emits `listing.title` byte-for-byte
 *      without a `.trim()` (the pass-through preserves byte-
 *      fidelity to the wire shape; if Lattice introduces title
 *      padding upstream in the future, the pass-through
 *      observability lock catches the diff in the unit tests).
 *      **Eleventh cohort plugin to omit D-10**.
 *
 *   3. **D-11 — wire `departments[0].name` `.trim()` APPLIED for
 *      the first time in cohort history.** 3 of 11 wire department
 *      names in the run-284 probe carry trailing ASCII-space
 *      padding (`'Customer Account Management '` × 1, `'Product '`
 *      × 2 listings; ~27 % pad rate). The plugin applies `.trim()`
 *      to `listing.departments?.[0]?.name` before downstream
 *      filters and emit so the case-insensitive
 *      `searchTerm.toLowerCase().includes(...)` filter sees the
 *      trimmed form, and the emitted `JobPostDto.department` does
 *      not carry pad bytes. **First cohort plugin to apply D-11**
 *      — opening the deviation axis from "fully-clean
 *      pass-through" to "trim-on-emit". Twenty-three prior cohort
 *      plugins emitted department names byte-for-byte because
 *      their wire data was 0/N padded.
 *
 * Shared with Honeycomb:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Lattice's `content`
 *     is HTML-entity-encoded (`&lt;h2&gt;&lt;strong&gt;This is
 *     Sales at Lattice&lt;/strong&gt;&lt;/h2&gt;...`), so the
 *     plugin decodes entities BEFORE stripping tags. **Thirtieth**
 *     plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Lattice'`
 *     byte-for-byte (the single-token bare brand name; case-
 *     symmetric with the lowercase slug `lattice`; no legal-entity
 *     suffix on the wire). The plugin reads `listing.company_name`
 *     directly with `'Lattice'` as a defensive fallback.
 *     **Twenty-fourth cohort plugin to omit D-09**, returning to
 *     the case-symmetric bare-brand wire form.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/lattice/jobs';

@SourcePlugin({
  site: Site.LATTICE,
  name: 'Lattice',
  category: 'company',
})
@Injectable()
export class LatticeService implements IScraper {
  private readonly logger = new Logger(LatticeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Lattice: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/11 wire titles padded in run-284 probe;
        // pass through byte-for-byte.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied: 3/11 wire department names padded in run-284
        // probe; trim on read so the search filter and emitted DTO
        // both see the clean form. First cohort plugin to apply D-11.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `lattice-${jobId}`;

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
            site: Site.LATTICE,
            title,
            // D-09 omitted: wire `company_name === 'Lattice'`
            // byte-for-byte; pass-through with a defensive
            // `'Lattice'` fallback.
            companyName: listing.company_name ?? 'Lattice',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-15 bare-domain
            // shape `lattice.com/job?gh_jid=<id>`). Fallback uses
            // canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the bare-domain shape, because
            // the fallback can only produce a guaranteed-resolvable
            // URL using the Greenhouse subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/lattice/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trimmed form (no pad bytes); first
            // cohort plugin to apply D-11.
            department,
          }),
        );
      }

      this.logger.log(`Lattice: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Lattice scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
