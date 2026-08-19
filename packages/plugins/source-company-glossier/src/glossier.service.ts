import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Glossier, Inc. — operator of the dominant
 * direct-to-consumer beauty brand pioneered out of the Into the
 * Gloss editorial blog (founded by Emily Weiss in 2014 in
 * New York City; raised $266M+ across rounds led by Forerunner
 * Ventures, IVP, Sequoia Capital, and Tiger Global at a peak
 * $1.8B valuation in 2019; operates an omnichannel retail
 * footprint across freestanding flagship stores in New York City
 * (Soho), Brooklyn, Boston, Chicago, Atlanta, Los Angeles, Las
 * Vegas, Philadelphia, Washington DC, plus wholesale distribution
 * into Sephora since 2023) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `glossier` (the
 * lowercase brand name; no whitespace transform required since the
 * brand is a single word; see Spec 072 § 10 D-05). The wire
 * `company_name` is the single-token bare brand `'Glossier'`
 * byte-for-byte.
 *
 * **Zero structural deviations from the Flexport (Spec 070) template** —
 * making this the **third** Greenhouse-only company-direct plugin in
 * run-history to ship as a clean re-spin of a prior cohort plugin
 * with no per-axis deviations (after Coursera off Chime at run #278
 * and Flexport off Faire at run #280).
 *
 * Shared with Flexport:
 *
 *   - **D-04 — wire-shape variant 10 fallback URL.** Glossier's
 *     tenant publishes its `absolute_url` on the **legacy hosted-
 *     board** apex `https://boards.greenhouse.io/glossier/jobs/<id>?gh_jid=<id>`
 *     — the bare `boards.greenhouse.io` host without the `job-`
 *     prefix, plus a trailing `?gh_jid=<id>` query suffix.
 *     **Fourth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, and Flexport); distinct from variant 2's modern
 *     US-region permalink subdomain `job-boards.greenhouse.io/<slug>/jobs/<id>`
 *     used by Coursera, Cameo, Carta, and the rest of the
 *     variant-2 cohort. The fallback `jobUrl` constructor mirrors
 *     this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Glossier's `content`
 *     is HTML-entity-encoded (`&lt;h3&gt;&lt;strong&gt;Overview&lt;/strong&gt;&lt;/h3&gt;
 *     &lt;div&gt;...&amp;nbsp;...`), so the plugin decodes entities
 *     BEFORE stripping tags. **Twenty-eighth** plugin in the cohort
 *     to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Glossier'`
 *     byte-for-byte (the single-token bare brand name; no legal-
 *     entity suffix on the wire — distinct from the legal-entity
 *     name "Glossier, Inc." that may appear in corporate filings).
 *     The plugin reads `listing.company_name` directly with
 *     `'Glossier'` as a defensive fallback. **Twenty-second cohort
 *     plugin to omit D-09**, returning to the single-word bare-
 *     brand wire form.
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 2 of 17
 *     wire titles in the run-282 probe carry whitespace padding —
 *     one with a **leading** ASCII-space (`' (Sales Associate,
 *     Part-Time) Editor, Los Angeles'`) and one with a **double
 *     trailing** ASCII-space (`'(Seasonal Sales Associate, Part-
 *     Time) Editor, Boston  '`). **Glossier is the first cohort
 *     plugin where the observed pad-byte distribution includes a
 *     leading-pad case AND a multi-byte trailing-pad case** —
 *     distinct from the trailing-single-pad uniform distributions
 *     of fuboTV, Flexport, and the prior D-10 cohort. Standard
 *     `String.prototype.trim()` handles both axes, so the existing
 *     one-line `.trim()` semantics carry through unchanged. The
 *     plugin applies `.trim()` to the wire `title` before
 *     downstream filters and emit. **Thirteenth cohort plugin to
 *     apply D-10** (after Brex, Buildkite, ZoomInfo, Attentive,
 *     Elastic, Intercom, Mixpanel, Faire, Carta, ClassPass, Epic
 *     Games, Flexport, and fuboTV).
 *
 *   - **D-11 — fully-clean department pass-through.** Glossier's
 *     wire department names are 0 of 17 padded (0 % pad rate). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the clean
 *     wire data; if Glossier adds padding upstream in the future,
 *     the pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/glossier/jobs';

@SourcePlugin({
  site: Site.GLOSSIER,
  name: 'Glossier',
  category: 'company',
})
@Injectable()
export class GlossierService implements IScraper {
  private readonly logger = new Logger(GlossierService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Glossier: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — Glossier's wire emits both forms in run-282
        // probe).
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
        const id = `glossier-${jobId}`;

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
            site: Site.GLOSSIER,
            title,
            companyName: listing.company_name ?? 'Glossier',
            // D-04: variant-10 legacy hosted-board fallback —
            // `boards.greenhouse.io/<slug>/jobs/<id>?gh_jid=<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://boards.greenhouse.io/glossier/jobs/${listing.id}?gh_jid=${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 17 padded in run
            // #282 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Glossier: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Glossier scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
