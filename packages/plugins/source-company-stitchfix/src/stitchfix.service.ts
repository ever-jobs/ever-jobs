import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Stitch Fix, Inc. — operator of the dominant data-science-driven
 * personal-styling-by-mail e-commerce platform pioneered around the
 * algorithmic style-recommendation longitudinal-fashion data model
 * (founded by Katrina Lake in 2011 in San Francisco; IPO'd on
 * NASDAQ as `SFIX` in November 2017 at a $1.6B valuation — peaking
 * near $11B in 2021; ships a hybrid human-stylist / algorithmic-
 * recommendation styling-as-a-service product across women's,
 * men's, and kids' apparel-and-accessories segments — alongside
 * competitors Trunk Club, Wantable, Daily Look, and Le Tote — with
 * a hybrid in-office / remote workforce concentrated across the
 * United States and the United Kingdom) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `stitchfix` (the lowercase concatenated two-word brand-words;
 * case-asymmetric AND length-asymmetric with the wire `company_name
 * === 'Stitch Fix'` which carries the brand's two-word internal-
 * whitespace form; see Spec 077 § 10 D-05). The wire `company_name`
 * is the literal two-word brand string `'Stitch Fix'` byte-for-
 * byte (10 bytes; slug `stitchfix` is 9 bytes — slug/wire-
 * asymmetric, wire LONGER than slug by 1 byte (the internal ASCII
 * space at index 6 between `Stitch` and `Fix`)).
 *
 * **One structural deviation from the Maven Clinic (Spec 076)
 * template** — D-04 wire-shape variant 16 (first cohort plugin to
 * use variant 16; distinct from Maven Clinic's variant 2 modern
 * hosted-board apex shape). All other axes share with Maven Clinic:
 * D-08 entity-decode-then-tag-strip, D-09 omitted with internal-
 * whitespace wire asymmetry (Stitch Fix +1 byte / single-internal-
 * space — same as Maven Clinic +1 byte / single-internal-space —
 * same as Scale AI +1 byte / single-internal-space), D-10 applied
 * (Stitch Fix 3/22 padded; Maven Clinic 3/24 padded — near-
 * identical pad rate ~13.6 % vs ~12.5 %), D-11 fully-clean
 * department pass-through.
 *
 *   1. **D-04 — wire-shape variant 16 (bare-www brand-domain
 *      `/careers/jobs`-path duplicate-`gh_jid`-query).** Stitch
 *      Fix's tenant publishes its `absolute_url` on a **previously-
 *      unobserved bare-www brand-domain shape**
 *      `https://www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
 *      (`www.stitchfix.com` — `www` subdomain on the bare brand
 *      domain, distinct from variant 14's `careers.fubo.tv` vanity
 *      subdomain and variant 15's bare `lattice.com`; plural
 *      `/careers/jobs` path — distinct from variant 13's
 *      `careers/jobs/<id>?gh_jid=<id>` per-id-in-path shape and
 *      variant 15's singular `/job` path; the listing ID appears
 *      **twice** in the same `gh_jid` query parameter — the
 *      duplicate query parameter is the most distinctive feature
 *      and is distinct from every prior cohort variant where the
 *      same query parameter appears at most once). This is the
 *      **first** plugin in the cohort to use **wire-shape variant
 *      16** — the **nineteenth distinct wire-shape variant** in
 *      the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination (including the duplicate
 *      `gh_jid` query parameter). The **fallback** `jobUrl`
 *      constructor (when Greenhouse omits `absolute_url` — a
 *      defence-in-depth path Greenhouse has not exercised against
 *      this tenant in the audit window) defaults to the canonical
 *      Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/stitchfix/jobs/<id>`
 *      rather than reconstructing the bare-domain duplicate-query
 *      shape, because the bare-domain shape requires
 *      `stitchfix.com`-side proxying that may not be guaranteed
 *      for all listing IDs (same fallback strategy as ClassPass —
 *      Spec 067 § 10 D-04 — Epic Games — Spec 069 § 10 D-04 —
 *      fuboTV — Spec 071 § 10 D-04 — and Lattice — Spec 074 § 10
 *      D-04).
 *
 * Shared with Maven Clinic:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Stitch Fix's
 *     `content` is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;h3&gt;&lt;strong&gt;About Stitch Fix, Inc. &lt;/strong&gt;&lt;/h3&gt;
 *     &lt;p&gt;Stitch Fix (NASDAQ: SFIX) is the leading online
 *     personal styling service...`), so the plugin decodes
 *     entities BEFORE stripping tags. **Thirty-third** plugin in
 *     the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (with internal-whitespace
 *     asymmetry).** Wire `company_name === 'Stitch Fix'` byte-
 *     for-byte (the two-word brand name with single internal
 *     ASCII space at byte index 6; no legal-entity suffix on the
 *     wire — distinct from the legal-entity name "Stitch Fix,
 *     Inc." that may appear in corporate filings AND in the wire
 *     `content` payload `About Stitch Fix, Inc.`). The plugin
 *     reads `listing.company_name` directly with `'Stitch Fix'`
 *     as a defensive fallback. **Twenty-seventh cohort plugin to
 *     omit D-09**, but the **seventh slug/wire asymmetry case
 *     overall** (after Ramp Network, Scale AI, fuboTV, Honeycomb,
 *     MasterClass, and Maven Clinic) — and the **third** internal-
 *     whitespace asymmetry case in the cohort after Scale AI and
 *     Maven Clinic (same +1 byte differential, same single-
 *     internal-space delta — proving out that internal-whitespace
 *     asymmetry is a stable recurring axis rather than a two-off
 *     pattern).
 *
 *   - **D-10 — wire-title `.trim()` applied.** 3 of 22 wire titles
 *     in the run-287 probe carry trailing ASCII-space padding
 *     (`'Principal Full-Stack Data Scientist - Recommendation
 *     Algorithms '`, `'Senior Manager of Data Engineering and AI
 *     Automation, Business Systems '`, `'Strategic Program
 *     Manager, Styling Enablement '` — all single-trailing-space-
 *     padded; ~13.6 % pad rate). The plugin applies `.trim()` to
 *     the wire `title` before downstream filters and emit.
 *     **Sixteenth cohort plugin to apply D-10** (after Brex,
 *     Buildkite, ZoomInfo, Attentive, Elastic, Intercom, Mixpanel,
 *     Faire, Carta, ClassPass, Epic Games, Flexport, fuboTV,
 *     Glossier, Honeycomb, and Maven Clinic).
 *
 *   - **D-11 — fully-clean department pass-through.** Stitch Fix's
 *     wire department names are 0 of 22 padded (0 % pad rate —
 *     `'Engineering'`, `'Data Platform'`, `'Marketing'`,
 *     `'Product'`, etc.). The plugin emits the wire
 *     `departments[0].name` byte-for-byte without a `.trim()`
 *     (the pass-through is a no-op on the clean wire data; if
 *     Stitch Fix adds padding upstream in the future, the pass-
 *     through observability lock catches the diff in the unit
 *     tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/stitchfix/jobs';

@SourcePlugin({
  site: Site.STITCHFIX,
  name: 'Stitch Fix',
  category: 'company',
})
@Injectable()
export class StitchfixService implements IScraper {
  private readonly logger = new Logger(StitchfixService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Stitch Fix: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 3 of 22 wire titles in run-287 probe carry
        // single-trailing-space padding).
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
        const id = `stitchfix-${jobId}`;

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
            site: Site.STITCHFIX,
            title,
            // D-09 omitted: internal-whitespace-asymmetric wire
            // `company_name` is `'Stitch Fix'` byte-for-byte
            // (10 bytes; 1 byte longer than slug `stitchfix`
            // via the internal ASCII space at index 6);
            // pass-through with a defensive `'Stitch Fix'`
            // fallback locks the slug/wire internal-whitespace
            // asymmetry observable.
            companyName: listing.company_name ?? 'Stitch Fix',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-16 bare-www
            // brand-domain shape
            // `www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
            // — including the duplicate `gh_jid` query parameter).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the bare-domain duplicate-query
            // shape, because the fallback can only produce a
            // guaranteed-resolvable URL using the Greenhouse
            // subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/stitchfix/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 22 padded in run
            // #287 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Stitch Fix: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Stitch Fix scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
