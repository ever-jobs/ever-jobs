import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * New Relic, Inc. — operator of the dominant SaaS observability
 * platform pioneered around the unified-telemetry-and-AI-monitoring
 * data model (founded by Lew Cirne in 2008 in San Francisco;
 * IPO'd on NYSE as `NEWR` in December 2014; taken private by
 * Francisco Partners and TPG Capital in November 2023 at a $6.5B
 * valuation; ships the New Relic One unified observability
 * platform across the cybersecurity / SRE / DevOps / Performance-
 * Monitoring segment — alongside competitors Datadog, Dynatrace,
 * Splunk, Grafana Labs, and Honeycomb — with a hybrid distributed
 * workforce concentrated across San Francisco, Portland OR,
 * Atlanta, Dublin, Barcelona, and Remote across the United
 * States, Europe, and Asia-Pacific) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `newrelic`
 * (the lowercase concatenated two-word brand-words; case-
 * asymmetric AND length-asymmetric with the wire `company_name
 * === 'New Relic'`; see Spec 085 § 10 D-05). The wire
 * `company_name` is the literal two-word brand string
 * `'New Relic'` byte-for-byte (9 bytes; slug `newrelic` is 8
 * bytes — slug/wire-asymmetric, wire LONGER than slug by 1 byte
 * via the internal ASCII space at index 3 between `New` and
 * `Relic`).
 *
 * **Zero structural deviations from the Maven Clinic (Spec 076)
 * template** — making this the **sixth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin of a prior cohort plugin with no per-axis deviations
 * (after Coursera off Chime at run #278, Flexport off Faire at
 * run #280, Glossier off Flexport at run #282, and Marqeta off
 * Calendly at run #294). All axes share with Maven Clinic: D-04
 * wire-shape variant 2 (canonical Greenhouse host), D-08
 * entity-decode-then-tag-strip, D-09 omitted with internal-
 * whitespace wire asymmetry (New Relic +1 byte / single-internal-
 * space — same as Maven Clinic +1 byte / single-internal-space
 * — same as Scale AI / Stitch Fix), D-10 applied (New Relic
 * 16/74 padded ~21.6 % vs Maven Clinic 3/24 padded ~12.5 %), and
 * D-11 omitted (departments fully clean).
 *
 * **Cohort observation of note:** New Relic's wire title pad
 * rate ~21.6 % is the **second-highest D-10 pad rate observed
 * in the cohort to date** (after fuboTV's run-281 ~91 % outlier).
 * Pad-form distribution across the 16 padded titles: 4 leading-
 * only, 12 trailing-only, 1 BOTH-LEADING-AND-TRAILING (`" Account
 * Executive - Commercial "` — pad bytes on both sides). **First
 * cohort observation of dual-pad on the title axis** — opening
 * a new sub-axis under D-10 analogous to DataCamp's run-291
 * leading-pad sub-axis under D-11. Standard
 * `String.prototype.trim()` handles all three sub-axes
 * (leading-only, trailing-only, dual) in a single call, so the
 * plugin implementation is byte-identical to Maven Clinic's
 * `(listing.title ?? '').trim()` form — this is a new
 * observation, NOT a structural deviation.
 *
 * Shared with Maven Clinic:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/newrelic/jobs/<id>`.
 *     **Twentieth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     New Relic's `content` is HTML-entity-encoded
 *     (`&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;We
 *     are a global team of innovators and pioneers dedicated to
 *     shaping the future of observability. At New Relic, we
 *     build an intelligent platform...`). **Forty-first** plugin
 *     to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (internal-whitespace
 *     asymmetry).** Wire `company_name === 'New Relic'` byte-
 *     for-byte. Slug/wire-asymmetric — wire 9 bytes vs slug 8
 *     bytes. Same shape as Maven Clinic, Stitch Fix, Scale AI.
 *     **Thirty-fourth cohort plugin to omit D-09**, ninth slug/
 *     wire asymmetry case overall, fourth internal-whitespace
 *     asymmetry case.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 16 of 74 wire
 *     titles in the run-295 probe carry pad bytes (~21.6 % pad
 *     rate). Pad-form distribution: 4 leading-only, 12
 *     trailing-only, 1 BOTH-LEADING-AND-TRAILING. **Twenty-first
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 74
 *     wire department names padded (`'Commercial'`,
 *     `'Enterprise'`, `'Marketing'`, `'Technical Solution Sales'`,
 *     `'G&A, Executive'`, `'Alliances & Channels'`, `'Content,
 *     Creative & Communications'`, `'New Relic Global
 *     Enablement'` — clean multi-token forms with internal
 *     whitespace, ampersands, and commas). **Thirty-first
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/newrelic/jobs';

@SourcePlugin({
  site: Site.NEWRELIC,
  name: 'New Relic',
  category: 'company',
})
@Injectable()
export class NewRelicService implements IScraper {
  private readonly logger = new Logger(NewRelicService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`New Relic: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 16/74 padded in run-295 probe.
        // Standard `String.prototype.trim()` handles all three
        // pad-form sub-axes (leading-only, trailing-only, BOTH-
        // LEADING-AND-TRAILING) in a single call — no special-
        // casing needed. First cohort observation of dual-pad
        // on the title axis (`" Account Executive - Commercial "`).
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
        const id = `newrelic-${jobId}`;

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
            site: Site.NEWRELIC,
            title,
            // D-09 omitted: internal-whitespace-asymmetric wire
            // `company_name === 'New Relic'` byte-for-byte (9
            // bytes; 1 byte longer than slug `newrelic` via the
            // internal ASCII space at index 3); pass-through with
            // a defensive `'New Relic'` fallback.
            companyName: listing.company_name ?? 'New Relic',
            // D-04: wire `absolute_url` flows through (variant 2);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/newrelic/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/74 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`New Relic: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`New Relic scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
