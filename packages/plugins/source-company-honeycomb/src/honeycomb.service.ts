import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Honeycomb.io, Inc. — operator of the dominant production-
 * observability platform pioneered around the high-cardinality
 * event-as-the-unit-of-work data model (founded by Christine Yen
 * and Charity Majors in 2016 in San Francisco; raised $200M+
 * across rounds led by Insight Partners, Scale Venture Partners,
 * e.ventures, Storm Ventures, and Headline at a Series D
 * valuation; coined the modern usage of "observability" in
 * software engineering through Charity Majors's writing and
 * conference talks; ships an OpenTelemetry-native SaaS product
 * across the engineering-observability segment alongside
 * competitors Datadog, New Relic, Splunk, and Grafana Cloud, with
 * a remote-first workforce concentrated across the United States,
 * United Kingdom, Ireland, and Canada) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `honeycomb` (the lowercase brand name without the `.io` TLD
 * that appears in the wire `company_name`; see Spec 073 § 10
 * D-05). The wire `company_name` is the brand-with-TLD
 * `'Honeycomb.io'` byte-for-byte (12 bytes; slug `honeycomb` is
 * 9 bytes — slug/wire-asymmetric, wire LONGER than slug by the
 * 3-byte `.io` TLD suffix).
 *
 * **One structural deviation from the Carta (Spec 066) template** —
 * D-09 omitted with TLD-suffix wire asymmetry (the wire
 * `company_name` carries the brand's `.io` TLD as a 3-byte
 * trailing suffix; the **fourth** slug/wire asymmetry case in the
 * cohort after Ramp Network, Scale AI, and fuboTV; the **second**
 * asymmetry case where the wire is longer than the slug after
 * Scale AI; the **first** cohort plugin where the wire
 * `company_name` carries the brand's TLD as a trailing suffix).
 *
 * Shared with Carta:
 *
 *   - **D-04 — wire-shape variant 2 fallback URL.** Honeycomb's
 *     tenant publishes its `absolute_url` on the modern
 *     `https://job-boards.greenhouse.io/honeycomb/jobs/<id>` shape
 *     — the **fifteenth** plugin in the cohort to use variant 2
 *     (after Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify,
 *     Postman, Webflow, Attentive, Intercom, Mixpanel, Scale AI,
 *     Cameo, and Carta). The fallback `jobUrl` constructor mirrors
 *     this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Honeycomb's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;div&gt;&lt;strong&gt;What We're Building&lt;/strong&gt;
 *     &lt;/div&gt;...`), so the plugin decodes entities BEFORE
 *     stripping tags. **Twenty-ninth** plugin in the cohort to
 *     apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (with TLD-suffix
 *     asymmetry).** Wire `company_name === 'Honeycomb.io'`
 *     byte-for-byte (the brand name with the `.io` TLD as a
 *     trailing 3-byte suffix; no legal-entity suffix on the wire
 *     — distinct from the legal-entity name "Honeycomb.io, Inc."
 *     that may appear in corporate filings). The plugin reads
 *     `listing.company_name` directly with `'Honeycomb.io'` as a
 *     defensive fallback. **Twenty-third cohort plugin to omit
 *     D-09**, but the **fourth** slug/wire asymmetry case in the
 *     cohort (after Ramp Network slug `rampnetwork` / wire
 *     `'Ramp'`, Scale AI slug `scaleai` / wire `'Scale AI'`, and
 *     fuboTV slug `fubotv` / wire `'Fubo'`) — and the **second**
 *     asymmetry case where the wire `company_name` is **longer**
 *     than the slug (after Scale AI's 8-byte wire `'Scale AI'`
 *     vs. 7-byte slug `scaleai`). Honeycomb is the **first**
 *     cohort plugin where the wire `company_name` carries the
 *     brand's TLD as a 3-byte trailing suffix (`.io`).
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 2 of 10
 *     wire titles in the run-283 probe carry trailing ASCII-space
 *     padding (`'Staff Solution Architect '` × 2 listings — IDs
 *     5162709008 and 5162707008 — both single-trailing-space-
 *     padded; ~20 % pad rate). The plugin applies `.trim()` to
 *     the wire `title` before downstream filters and emit.
 *     **Fourteenth cohort plugin to apply D-10** (after Brex,
 *     Buildkite, ZoomInfo, Attentive, Elastic, Intercom,
 *     Mixpanel, Faire, Carta, ClassPass, Epic Games, Flexport,
 *     fuboTV, and Glossier).
 *
 *   - **D-11 — fully-clean department pass-through.** Honeycomb's
 *     wire department names are 0 of 10 padded (0 % pad rate —
 *     `'Sales'`, `'Finance & Accounting'`, `'RevOps'`). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the
 *     clean wire data; if Honeycomb adds padding upstream in the
 *     future, the pass-through observability lock catches the
 *     diff in the unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/honeycomb/jobs';

@SourcePlugin({
  site: Site.HONEYCOMB,
  name: 'Honeycomb',
  category: 'company',
})
@Injectable()
export class HoneycombService implements IScraper {
  private readonly logger = new Logger(HoneycombService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Honeycomb: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 2 of 10 wire titles in run-283 probe carry
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
        const id = `honeycomb-${jobId}`;

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
            site: Site.HONEYCOMB,
            title,
            // D-09 omitted: TLD-suffix wire `company_name` is
            // `'Honeycomb.io'` byte-for-byte; pass-through with a
            // defensive `'Honeycomb.io'` fallback locks the
            // slug/wire TLD-suffix asymmetry observable.
            companyName: listing.company_name ?? 'Honeycomb.io',
            // D-04: variant-2 modern hosted-board fallback —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/honeycomb/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 10 padded in run
            // #283 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Honeycomb: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Honeycomb scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
