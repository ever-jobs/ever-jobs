import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * fuboTV (now branded "Fubo") — operator of the dominant
 * sports-first-live-TV-streaming platform (founded as Fanvision
 * by David Gandler, Sung Ho Ahn, and Alberto Horihuela in 2015 in
 * New York City; rebranded to fuboTV in 2017; rebranded again to
 * Fubo in 2023; publicly traded on NYSE under ticker `FUBO` since
 * the 2020 IPO; combined with Hulu + Live TV in 2025; operating
 * with anchor offices in New York City (HQ), Paris, and
 * Bengaluru) — publishes its consolidated careers board through
 * Greenhouse at the legacy `fubotv` slug (the lowercase brand
 * name with the legacy "TV" suffix; see Spec 071 § 10 D-05). The
 * wire `company_name` is the single-token bare brand `'Fubo'`
 * byte-for-byte (reflecting the 2023 rename), **byte-distinct
 * from the slug `fubotv`** — this is the **third** slug/wire
 * asymmetry case in the cohort after Ramp Network (slug
 * `rampnetwork`, wire `'Ramp'`) and Scale AI (slug `scaleai`,
 * wire `'Scale AI'`) — but the **first** asymmetry case where
 * the wire is shorter than the slug.
 *
 * **Two structural deviations from the ClassPass (Spec 067)
 * template:**
 *
 *   1. **D-04 — wire-shape variant 14 (vanity-domain fixed-path
 *      query-only-id).** fuboTV's tenant publishes its
 *      `absolute_url` on a **previously-unobserved vanity-domain
 *      shape** `https://careers.fubo.tv/fubotv-job-openings/?gh_jid=<id>`
 *      (vanity-domain `careers.fubo.tv` rather than the parent
 *      `fubotv.com` or any `jobs.fubo.tv` subdomain;
 *      `fubotv-job-openings/` fixed path; single `gh_jid` query
 *      parameter — the listing ID appears **only** in the query
 *      parameter, not in the path — distinct from variant 12's
 *      `careers/opportunities/<id>?gh_jid=<id>` shape and variant
 *      13's `careers/jobs/<id>?gh_jid=<id>` shape, where the ID is
 *      duplicated in both path and query). This is the **first**
 *      plugin in the cohort to use **wire-shape variant 14** —
 *      the **seventeenth distinct wire-shape variant** in the
 *      company-direct cohort and the **first** to publish the
 *      listing ID **only** in the query parameter (no
 *      path-embedded ID).
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination. The **fallback**
 *      `jobUrl` constructor (when Greenhouse omits
 *      `absolute_url` — a defence-in-depth path Greenhouse has
 *      not exercised against this tenant in the audit window)
 *      defaults to the canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/fubotv/jobs/<id>` rather
 *      than reconstructing the vanity-domain shape, because the
 *      vanity-domain shape requires `fubo.tv`-side proxying that
 *      may not be guaranteed for all listing IDs (same fallback
 *      strategy as ClassPass — Spec 067 § 10 D-04 — and Epic
 *      Games — Spec 069 § 10 D-04).
 *
 *   2. **D-12 — wire-`location.name` `.trim()` applied (new
 *      axis).** 11 of 11 wire `location.name` values in the
 *      run-281 probe carry trailing ASCII-space padding
 *      (`'New York, NY '` and `'Denver, CO '` — 100 % pad-rate).
 *      The plugin applies `.trim()` to `listing.location?.name`
 *      before constructing the `LocationDto({ city })` so
 *      downstream consumers see clean `'New York, NY'`. **First
 *      cohort plugin to apply D-12** — opening a new deviation
 *      axis. The `isRemote` derivation uses the pre-trim raw
 *      `locationStr` for substring matching since the trim
 *      doesn't change semantic content for that boolean flag.
 *
 * Shared with ClassPass:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     fuboTV's `content` is HTML-entity-encoded (`&lt;p&gt;
 *     &lt;strong&gt;About Fubo:&lt;/strong&gt;&lt;/p&gt;...`), so
 *     the plugin decodes entities BEFORE stripping tags.
 *     **Twenty-seventh** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Fubo'`
 *     byte-for-byte. The plugin reads `listing.company_name`
 *     directly with `'Fubo'` as a defensive fallback.
 *     **Twenty-first cohort plugin to omit D-09**, returning to
 *     the single-word bare-brand wire form.
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 10 of 11
 *     wire titles in the run-281 probe carry trailing ASCII-
 *     space padding (~91 % pad rate, the **highest pad rate
 *     observed in the cohort to date**). The plugin applies
 *     `.trim()` to the wire `title` before downstream filters
 *     and emit. **Thirteenth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** fuboTV's
 *     wire department names are 0 of 11 padded (0 % pad rate).
 *     The plugin emits the wire `departments[0].name`
 *     byte-for-byte without a `.trim()`.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fubotv/jobs';

@SourcePlugin({
  site: Site.FUBOTV,
  name: 'fuboTV',
  category: 'company',
})
@Injectable()
export class FubotvService implements IScraper {
  private readonly logger = new Logger(FubotvService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`fuboTV: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title before downstream filters and emit.
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
        const id = `fubotv-${jobId}`;

        // Use the raw wire `location.name` for `isRemote`
        // substring matching and for the `input.location` filter
        // (case-insensitive `.includes()` is semantically correct
        // against either trimmed or padded form). The emitted
        // `LocationDto.city` uses the trimmed form per D-12.
        const rawLocationStr = listing.location?.name ?? null;
        const locationStr = rawLocationStr ? rawLocationStr.trim() : null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && rawLocationStr) {
          if (!rawLocationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.FUBOTV,
            title,
            companyName: listing.company_name ?? 'Fubo',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-14
            // vanity-domain fixed-path query-only-id shape
            // `careers.fubo.tv/fubotv-job-openings/?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the vanity-domain shape.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fubotv/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: rawLocationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 11 padded in run
            // #281 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`fuboTV: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`fuboTV scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
