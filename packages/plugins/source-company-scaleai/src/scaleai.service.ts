import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Scale AI, Inc. — AI data-labelling and frontier-AI training-data
 * infrastructure vendor (operator of Scale Data Engine, Scale GenAI
 * Platform, Scale Donovan, Scale Spellbook, Scale Studio, Scale
 * Document AI, Scale Forge, and the Scale Public Sector business
 * unit) — publishes its consolidated careers board through Greenhouse
 * at the slug-form `scaleai` (the lowercase brand name with the `'AI'`
 * suffix collapsed to `'ai'` and the internal whitespace removed; see
 * Spec 064 § 10 D-05). The wire `company_name` preserves the multi-
 * token display form `'Scale AI'` (with internal ASCII space) byte-
 * for-byte.
 *
 * One structural deviation from the Mixpanel (Spec 062) template:
 *
 *   1. **D-10 omitted.** Mixpanel applied `.trim()` because 1 of 9
 *      wire titles (~11.1 %) carried trailing ASCII-space padding.
 *      Scale AI's wire titles are all trim-clean (0 of 11 in the
 *      run-274 probe — `'Account Executive, Saudi Arabia'`, `'AI
 *      Applications Ops Lead, GPS'`, `'AI Deployment Strategist
 *      Intern'`, `'AI Product Manager'`, `'AI Strategy Consultant,
 *      Frontier Tech'`, `'Analytics & Data Science Manager,
 *      Finance'`, `'[Annotations] Operations Associate'`,
 *      `'[Annotations] Operations Program Manager'`, `'Applied AI
 *      Engineer, Enterprise'`, `'Applied AI Engineer, Enterprise
 *      GenAI'`, `'Applied AI Engineer, Global Public Sector'`). The
 *      plugin emits `listing.title` byte-for-byte without a `.trim()`.
 *      Structurally analogous to Chime (Spec 059 § 10 D-10 — also
 *      omitted), distinct from the trim-applied cohort: Brex,
 *      Buildkite, ZoomInfo, Attentive, Elastic, Intercom, Mixpanel,
 *      and Faire.
 *
 * Shared with Mixpanel:
 *
 *   - **D-04 — wire-shape variant 2.** Scale AI's tenant publishes
 *     its `absolute_url` on the modern US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/scaleai/jobs/<id>` shape —
 *     the **twelfth** plugin in the cohort to use variant 2 (after
 *     Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify, Postman,
 *     Webflow, Attentive, Intercom, Mixpanel). The fallback `jobUrl`
 *     constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Scale AI's `content`
 *     is HTML-entity-encoded (`&lt;p&gt;As an Account Executive,
 *     you&#39;ll be responsible for growing the Global Public
 *     Sector business unit...`), so the plugin decodes entities
 *     BEFORE stripping tags. **Twentieth** plugin in the cohort to
 *     apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Scale AI'`
 *     byte-for-byte (the multi-token bare brand name with internal
 *     ASCII space; no legal-entity suffix); the plugin reads
 *     `listing.company_name` directly with `'Scale AI'` as a
 *     defensive fallback. **Fourteenth cohort plugin to omit D-09**,
 *     AND the **first to omit D-09 against a multi-token bare-brand
 *     wire `company_name`** (every prior D-09-omission plugin had a
 *     single-word bare-brand wire — Mixpanel `'Mixpanel'`, Faire
 *     `'Faire'`, Intercom `'Intercom'`, Elastic `'Elastic'`, Webflow
 *     `'Webflow'`, Attentive `'Attentive'`, Postman `'Postman'`,
 *     Netlify `'Netlify'`, Mercury `'Mercury'`, Buildkite
 *     `'Buildkite'`, CircleCI `'CircleCI'`, Toast `'Toast'`, plus the
 *     Ramp Network slug-collapse case where the wire `company_name
 *     === 'Ramp'` was single-word despite the slug being
 *     `rampnetwork`).
 *
 *   - **D-11 — multi-word descriptive department name pass-through.**
 *     Scale AI's wire `departments[0].name` payload uses multi-word
 *     descriptive department names with optional initialisms like
 *     `'GPS Sales'` (Global Public Sector Sales), `'Engineering'`,
 *     `'Product'`, `'Operations'`, `'Annotations'`, `'Public Sector'`
 *     — partly distinct from Mixpanel's strict flat single-token
 *     format and Faire's pure multi-word descriptive format in that
 *     the wire payload may carry internal whitespace combined with
 *     capitalised initialisms. The plugin emits the wire
 *     `departments[0].name` byte-for-byte.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/scaleai/jobs';

@SourcePlugin({
  site: Site.SCALEAI,
  name: 'Scale AI',
  category: 'company',
})
@Injectable()
export class ScaleaiService implements IScraper {
  private readonly logger = new Logger(ScaleaiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Scale AI: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: emit wire title byte-for-byte (no `.trim()`).
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
        const id = `scaleai-${jobId}`;

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
            site: Site.SCALEAI,
            title,
            companyName: listing.company_name ?? 'Scale AI',
            // D-04: variant-2 modern US-region permalink subdomain —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/scaleai/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Scale AI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Scale AI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
