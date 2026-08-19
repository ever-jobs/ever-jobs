import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Flexport, Inc. — operator of the dominant
 * software-defined-freight-forwarding and global-trade-orchestration
 * platform (founded by Ryan Petersen in 2013 in San Francisco;
 * raised $935M+ across rounds led by SoftBank, Founders Fund, and
 * DST Global at a peak $8B valuation; offers ocean / air / truck /
 * rail freight-forwarding, customs-brokerage, fulfillment-warehousing,
 * trade-financing (Flexport Capital), and the proprietary Flexport
 * Platform that consolidates shipment-tracking, document-management,
 * and trade-compliance workflows for ~30,000 importer/exporter
 * customers across 200+ countries) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `flexport` (the
 * lowercase brand name; no whitespace transform required since the
 * brand is a single word; see Spec 070 § 10 D-05). The wire
 * `company_name` is the single-token bare brand `'Flexport'`
 * byte-for-byte.
 *
 * **Zero structural deviations from the Faire (Spec 063) template** —
 * making this the **second** Greenhouse-only company-direct plugin in
 * run-history to ship as a clean re-spin of a prior cohort plugin
 * with no per-axis deviations (after Coursera off Chime at run #278).
 *
 * Shared with Faire:
 *
 *   - **D-04 — wire-shape variant 10 fallback URL.** Flexport's
 *     tenant publishes its `absolute_url` on the **legacy hosted-
 *     board** apex `https://boards.greenhouse.io/flexport/jobs/<id>?gh_jid=<id>`
 *     — the bare `boards.greenhouse.io` host without the `job-`
 *     prefix, plus a trailing `?gh_jid=<id>` query suffix. **Third**
 *     plugin in the cohort to use variant 10 (after Chime and
 *     Faire); distinct from variant 2's modern US-region permalink
 *     subdomain `job-boards.greenhouse.io/<slug>/jobs/<id>` used by
 *     Coursera, Cameo, Carta, and the rest of the variant-2 cohort.
 *     The fallback `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Flexport's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;h2&gt;&lt;strong&gt;About Flexport:&amp;nbsp;&lt;/strong&gt;
 *     &lt;/h2&gt;...`), so the plugin decodes entities BEFORE
 *     stripping tags. **Twenty-sixth** plugin in the cohort to apply
 *     D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Flexport'`
 *     byte-for-byte (the single-token bare brand name; no legal-
 *     entity suffix on the wire — distinct from the legal-entity
 *     name "Flexport, Inc." that may appear in corporate filings).
 *     The plugin reads `listing.company_name` directly with
 *     `'Flexport'` as a defensive fallback. **Twentieth cohort
 *     plugin to omit D-09**, returning to the single-word bare-
 *     brand wire form.
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 11 of 113
 *     wire titles in the run-280 probe carry trailing ASCII-space
 *     padding (`'Area Manager '`, `'Country Manager, Mexico '`,
 *     `'Manager, Air Operations '`, etc. — ~9.7 % pad rate, the
 *     highest pad rate observed in the cohort to date). The plugin
 *     applies `.trim()` to the wire `title` before downstream
 *     filters and emit. **Twelfth cohort plugin to apply D-10**
 *     (after Brex, Buildkite, ZoomInfo, Attentive, Elastic, Intercom,
 *     Mixpanel, Faire, Carta, ClassPass, and Epic Games).
 *
 *   - **D-11 — fully-clean department pass-through.** Flexport's
 *     wire department names are 0 of 113 padded (0 % pad rate). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the clean
 *     wire data; if Flexport adds padding upstream in the future,
 *     the pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/flexport/jobs';

@SourcePlugin({
  site: Site.FLEXPORT,
  name: 'Flexport',
  category: 'company',
})
@Injectable()
export class FlexportService implements IScraper {
  private readonly logger = new Logger(FlexportService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Flexport: fetching ${url}`);

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
        const id = `flexport-${jobId}`;

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
            site: Site.FLEXPORT,
            title,
            companyName: listing.company_name ?? 'Flexport',
            // D-04: variant-10 legacy hosted-board fallback —
            // `boards.greenhouse.io/<slug>/jobs/<id>?gh_jid=<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://boards.greenhouse.io/flexport/jobs/${listing.id}?gh_jid=${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 113 padded in run
            // #280 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Flexport: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Flexport scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
