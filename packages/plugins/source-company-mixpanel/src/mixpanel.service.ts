import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Mixpanel Inc. — product-analytics platform vendor (operator of
 * Mixpanel Analytics, Cohorts, Insights, Boards, Signal, Data
 * Pipelines, and Lexicon) — publishes its consolidated careers board
 * through Greenhouse at the bare `mixpanel` slug (no asymmetry; see
 * Spec 062 § 10 D-05).
 *
 * Zero structural deviations from the Intercom (Spec 061) template —
 * Mixpanel is a near-pure Intercom twin:
 *
 *   - **D-04 — wire-shape variant 2.** Mixpanel's tenant publishes its
 *     `absolute_url` on the US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/mixpanel/jobs/<id>` shape — the
 *     eleventh plugin in the cohort to use variant 2 (after Vercel,
 *     Affirm, Gusto, Mercury, Buildkite, Netlify, Postman, Webflow,
 *     Attentive, Intercom). The fallback `jobUrl` constructor mirrors
 *     this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.** Like
 *     every plugin from Klaviyo onwards, Mixpanel's `content` is
 *     HTML-entity-encoded (`&lt;p&gt;Mixpanel is the leading event-
 *     based product analytics platform...`), so the plugin decodes
 *     entities BEFORE stripping tags. Eighteenth plugin in the cohort
 *     to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Mixpanel'`
 *     byte-for-byte (no legal-entity suffix); the plugin reads
 *     `listing.company_name` directly without a string-literal pin.
 *
 *   - **D-10 — wire-title `.trim()`.** A subset of Mixpanel wire titles
 *     carry trailing ASCII-space padding (1 of 9 titles in the
 *     run-272 probe — ~11.1 %, e.g. `'Account Manager '`). The plugin
 *     applies `.trim()` to the wire `title` before the empty-title
 *     skip check AND before the `searchTerm` filter AND before the
 *     `JobPostDto` emit, so the emitted `title` is the trimmed form.
 *     Seventh plugin in the cohort to apply a wire-title trim (after
 *     Brex `Spec 047 § 10 D-10`, Buildkite `Spec 050 § 10 D-10`,
 *     ZoomInfo `Spec 057 § 10 D-10`, Attentive `Spec 058 § 10 D-10`,
 *     Elastic `Spec 060 § 10 D-10`, and Intercom `Spec 061 § 10 D-10`).
 *
 *   - **D-11 — flat single-token department name pass-through.**
 *     Mixpanel's wire `departments[0].name` payload uses flat
 *     single-token department names (`'Sales'`, `'Engineering'`,
 *     `'Product'`, `'Marketing'`, `'Customer Success'`, etc.) — distinct
 *     from Elastic's compound `' - '`-separated regional-scoped format,
 *     ZoomInfo's numeric-code-prefix format, Toast's colon-separated
 *     nested-path format, and Chime's single-token format. The plugin
 *     emits the wire `departments[0].name` byte-for-byte.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/mixpanel/jobs';

@SourcePlugin({
  site: Site.MIXPANEL,
  name: 'Mixpanel',
  category: 'company',
})
@Injectable()
export class MixpanelService implements IScraper {
  private readonly logger = new Logger(MixpanelService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Mixpanel: fetching ${url}`);

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
        const id = `mixpanel-${jobId}`;

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
            site: Site.MIXPANEL,
            title,
            companyName: listing.company_name ?? 'Mixpanel',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/mixpanel/jobs/${listing.id}`,
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

      this.logger.log(`Mixpanel: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Mixpanel scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
