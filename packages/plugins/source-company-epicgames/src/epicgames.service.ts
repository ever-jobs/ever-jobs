import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Epic Games, Inc. — operator of the dominant interactive-entertainment
 * publisher and engine vendor (founded by Tim Sweeney in 1991 in Cary,
 * North Carolina, originally as Potomac Computer Systems / Epic
 * MegaGames; rebranded to Epic Games in 1999; currently a private
 * company majority-owned by Tencent and the Sweeney family; operating
 * with anchor offices in Cary (HQ), Montreal, Vancouver, Bellevue,
 * Helsinki, Stockholm, London, and Seoul; operator of Fortnite,
 * Unreal Engine, the Epic Games Store, Bandcamp, Cubic Motion,
 * 3Lateral, Quixel, and Mediatonic) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `epicgames` (the
 * lowercase brand name with the inter-word space collapsed to a
 * single token; see Spec 069 § 10 D-05). The wire `company_name` is
 * the multi-token bare brand `'Epic Games'` (with internal whitespace)
 * byte-for-byte.
 *
 * One structural deviation from the ClassPass (Spec 067) template:
 *
 *   1. **D-04 wire-shape variant 13 (vanity-domain bare-brand).**
 *      ClassPass publishes `absolute_url` on **wire-shape variant 12**
 *      — the parent-domain shape
 *      `https://www.playlist.com/careers/opportunities/<id>?gh_jid=<id>`.
 *      Epic Games publishes on a previously-unobserved **wire-shape
 *      variant 13** — the bare brand-domain shape
 *      `https://epicgames.com/careers/jobs/<id>?gh_jid=<id>` (bare
 *      `epicgames.com` rather than `www.epicgames.com`; `careers/jobs`
 *      path; single `gh_jid` query parameter — distinct from
 *      ClassPass's parent-domain `www.playlist.com/careers/opportunities/<id>?gh_jid=<id>`
 *      and Elastic's variant-11 duplicate-`gh_jid` shape). This is
 *      the **second** vanity-domain variant in the cohort (after
 *      ClassPass's variant 12) — the **sixteenth distinct wire-shape
 *      variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination. The **fallback** `jobUrl`
 *      constructor (when Greenhouse omits `absolute_url` — a
 *      defence-in-depth path Greenhouse has not exercised against
 *      this tenant in the audit window) defaults to the canonical
 *      Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/epicgames/jobs/<id>` rather
 *      than reconstructing the vanity-domain shape, because the
 *      vanity-domain shape requires `epicgames.com`-side proxying
 *      that may not be guaranteed for all listing IDs (same fallback
 *      strategy as ClassPass — Spec 067 § 10 D-04).
 *
 * Shared with ClassPass:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Epic Games's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;h2&gt;WHAT MAKES US EPIC?&lt;/h2&gt;...`), so the plugin
 *     decodes entities BEFORE stripping tags. **Twenty-fifth** plugin
 *     in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Epic Games'`
 *     byte-for-byte (the multi-token bare brand name with internal
 *     whitespace; no legal-entity suffix on the wire — distinct from
 *     the legal-entity name "Epic Games, Inc." that appears in
 *     current SEC filings and the prior "Epic MegaGames, Inc." legal
 *     name from before the 1999 rebrand); the plugin reads
 *     `listing.company_name` directly with `'Epic Games'` as a
 *     defensive fallback. **Nineteenth cohort plugin to omit D-09**,
 *     and the **second** cohort plugin to ship with a multi-token
 *     bare-brand wire `company_name` (after Scale AI `'Scale AI'`).
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 2 of 74 wire
 *     titles in the run-279 probe carry trailing ASCII-space padding
 *     (`'Partnerships Director - Sports & Talent '` — twice, on two
 *     distinct listing IDs targeting the Cary, North Carolina office).
 *     The plugin applies `.trim()` to the wire `title` before
 *     downstream filters and emit. **Eleventh cohort plugin to apply
 *     D-10** (after Brex, Buildkite, ZoomInfo, Attentive, Elastic,
 *     Intercom, Mixpanel, Faire, Carta, and ClassPass).
 *
 *   - **D-11 — fully-clean department pass-through.** Epic Games's
 *     wire department names are 0 of 74 padded (0 % pad rate). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the clean
 *     wire data; if Epic Games adds padding upstream in the future,
 *     the pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/epicgames/jobs';

@SourcePlugin({
  site: Site.EPICGAMES,
  name: 'Epic Games',
  category: 'company',
})
@Injectable()
export class EpicgamesService implements IScraper {
  private readonly logger = new Logger(EpicgamesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Epic Games: fetching ${url}`);

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
        const id = `epicgames-${jobId}`;

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
            site: Site.EPICGAMES,
            title,
            companyName: listing.company_name ?? 'Epic Games',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-13 vanity-domain
            // shape `epicgames.com/careers/jobs/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather than
            // reconstructing the vanity-domain shape, because the
            // fallback can only produce a guaranteed-resolvable URL
            // using the Greenhouse subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/epicgames/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 74 padded in run
            // #279 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Epic Games: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Epic Games scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
