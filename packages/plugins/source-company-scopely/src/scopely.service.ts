import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Scopely Inc. — operator of the dominant mobile-games publishing
 * platform pioneered around the live-operations-and-licensed-IP-
 * game-portfolio data model (founded by Walter Driver, Eytan Elbaz,
 * Eric Futoran, and Ankur Bulsara in 2011 in Culver City, CA;
 * acquired by Savvy Games Group / Public Investment Fund of Saudi
 * Arabia in April 2023 at a $4.9B valuation; ships Monopoly GO!,
 * Star Trek Fleet Command, MARVEL Strike Force, WWE Champions,
 * Stumble Guys, and Pokémon GO (via the September 2024 acquisition
 * of Niantic's games division for $3.5B which brought Pikmin Bloom
 * under the Scopely umbrella) across the mobile-games segment —
 * alongside competitors Zynga, Playtika, Activision Blizzard
 * (King), Supercell, and Niantic — with a hybrid distributed
 * workforce concentrated across Culver City, Barcelona, Madrid,
 * Mexico City, Tel Aviv, Bangalore, Seoul, Tokyo, and Remote across
 * the United States, Europe, the Middle East, and Asia-Pacific) —
 * publishes its consolidated careers board through Greenhouse at
 * the bare slug `scopely` (the lowercase concatenated single-word
 * brand; case-symmetric with the wire `company_name === 'Scopely'`;
 * see Spec 087 § 10 D-05). The wire `company_name` is the literal
 * single-token bare-brand string `'Scopely'` byte-for-byte (7
 * bytes; case-symmetric with the lowercase 7-byte slug). All 170
 * listings in the run-297 probe (including listings tagged under
 * `departments[0].name === 'Niantic'` and `'Playgami'` operating-
 * division banners) carry the wire `'Scopely'` form.
 *
 * **Zero structural deviations from the Marqeta (Spec 084)
 * template** — making this the **seventh** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-spin
 * of a prior cohort plugin with no per-axis deviations (after
 * Coursera off Chime at run #278, Flexport off Faire at run #280,
 * Glossier off Flexport at run #282, Marqeta off Calendly at run
 * #294, and New Relic off Maven Clinic at run #295).
 *
 * Shared with Marqeta:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/scopely/jobs/<id>`.
 *     **Twentieth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Scopely's `content`
 *     is HTML-entity-encoded (`&lt;p&gt;&lt;strong&gt;Scopely&lt;
 *     /strong&gt; is the &lt;strong&gt;mobile-games publishing
 *     platform&lt;/strong&gt; behind Monopoly GO!, Star Trek
 *     Fleet Command, and MARVEL Strike Force...`), so the plugin
 *     decodes entities BEFORE stripping tags. **Forty-third**
 *     plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Scopely'` byte-for-byte (the single-
 *     token bare brand name; case-symmetric with the lowercase
 *     slug `scopely`); no legal-entity suffix on the wire —
 *     distinct from the legal-entity name "Scopely Inc." that
 *     appears in current SEC filings. The plugin reads
 *     `listing.company_name` directly with `'Scopely'` as a
 *     defensive fallback. **Thirty-sixth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 17 of 170 wire
 *     titles in the run-297 probe carry pad bytes (~10.0 % pad
 *     rate). Pad-form distribution: 2 leading-only, 12 trailing-
 *     only, 2 dual (`' D2C Program Manager '`, `' Senior
 *     Performance Marketing Manager '` — **second cohort
 *     observation of dual-pad on the title axis** after New
 *     Relic's run-295 single dual-pad; Scopely lifts dual-pad
 *     from a one-off to a recurring observation), 1 multi-byte
 *     trailing (`'Senior Software Engineer - Pikmin Bloom   '` —
 *     3 trailing ASCII spaces; **first cohort observation of
 *     multi-byte trailing pad**), 1 NBSP-trailing (`'Senior
 *     Analytics Engineer '` — U+00A0 non-breaking space;
 *     **first cohort observation of NBSP pad byte**). Standard
 *     `String.prototype.trim()` strips all five sub-axes in a
 *     single call (leading-only, trailing-only, dual, multi-byte
 *     trailing, NBSP-trailing) — no implementation change vs
 *     Marqeta. **Twenty-third cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** Scopely's
 *     wire department names are 0 of 170 padded (0 % pad rate —
 *     `'Slate Development Group'`, `'MonopolyGo'`, `'Finance'`,
 *     `'People'`, `'Legal'`, `'Slate Portfolio'`, `'Publishing'`,
 *     `'Operations'`, `'Niantic'`, `'Live Games Portfolio'`,
 *     `'Corporate'`, `'Playgami'` — clean multi-token forms
 *     with internal whitespace; the `'Niantic'` and `'Playgami'`
 *     department names are operating-division banners reflecting
 *     the post-acquisition structure, not separate Greenhouse
 *     tenants — distinct from prior cohort plugins where
 *     department names were strictly role-domain names). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()`. **Thirty-third cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/scopely/jobs';

@SourcePlugin({
  site: Site.SCOPELY,
  name: 'Scopely',
  category: 'company',
})
@Injectable()
export class ScopelyService implements IScraper {
  private readonly logger = new Logger(ScopelyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Scopely: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 17/170 padded in run-297 probe.
        // Standard `String.prototype.trim()` handles all five
        // sub-axes in a single call (leading-only, trailing-only,
        // dual, multi-byte trailing, NBSP U+00A0 trailing).
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
        const id = `scopely-${jobId}`;

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
            site: Site.SCOPELY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire form.
            companyName: listing.company_name ?? 'Scopely',
            // D-04: wire `absolute_url` flows through (variant 2);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/scopely/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/170 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Scopely: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Scopely scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
