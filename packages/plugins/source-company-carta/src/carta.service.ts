import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Carta, Inc. — cap-table-and-equity-management platform vendor
 * (operator of Carta Cap Table, Carta Fund Administration, Carta
 * Equity Plans, Carta Liquidity, Carta Total Comp, Carta X Tax, and
 * Carta Market Insights) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `carta` (the lowercase brand
 * name; no whitespace transform required since the brand is a single
 * word; see Spec 066 § 10 D-05). The wire `company_name` is the
 * single-token bare brand `'Carta'` byte-for-byte.
 *
 * Two structural deviations from the Cameo (Spec 065) template:
 *
 *   1. **D-10 applied.** Cameo's wire titles are 0 of 3 padded (zero
 *      pad rate). Carta carries at least 1 of 10 wire titles with a
 *      trailing ASCII-space pad byte (`'Business Development Manager,
 *      Private Equity '` — confirmed via run-276 WebFetch probe; the
 *      other 9 are clean — ~10 % pad rate). The plugin applies
 *      `.trim()` to the wire `title` before downstream filters and
 *      emit. Ninth cohort plugin to apply D-10 (after Brex `Spec 047
 *      § 10 D-10`, Buildkite `Spec 050 § 10 D-10`, ZoomInfo `Spec 057
 *      § 10 D-10`, Attentive `Spec 058 § 10 D-10`, Elastic `Spec 060
 *      § 10 D-10`, Intercom `Spec 061 § 10 D-10`, Mixpanel `Spec 062
 *      § 10 D-10`, and Faire `Spec 063 § 10 D-10`).
 *
 *   2. **D-11 fully-clean.** Cameo's wire department names carry 1 of
 *      3 with a trailing pad byte (~33.3 %). Carta's wire department
 *      names are 0 of 10 padded (0 %). The plugin still emits the
 *      wire `departments[0].name` byte-for-byte without a `.trim()`
 *      (the pass-through is a no-op on the clean wire data; if Carta
 *      adds padding upstream in the future, the pass-through
 *      observability lock catches the diff in the unit tests).
 *
 * Shared with Cameo:
 *
 *   - **D-04 — wire-shape variant 2.** Carta's tenant publishes its
 *     `absolute_url` on the modern US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/carta/jobs/<id>` shape — the
 *     **fourteenth** plugin in the cohort to use variant 2 (after
 *     Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify, Postman,
 *     Webflow, Attentive, Intercom, Mixpanel, Scale AI, and Cameo).
 *     The fallback `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Carta's `content` is
 *     HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;p&gt;&lt;strong&gt;About Carta&lt;/strong&gt;...`), so the
 *     plugin decodes entities BEFORE stripping tags. **Twenty-second**
 *     plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Carta'`
 *     byte-for-byte (the single-token bare brand name; no legal-
 *     entity suffix); the plugin reads `listing.company_name`
 *     directly with `'Carta'` as a defensive fallback. **Sixteenth
 *     cohort plugin to omit D-09**, returning to the single-word
 *     bare-brand wire form.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/carta/jobs';

@SourcePlugin({
  site: Site.CARTA,
  name: 'Carta',
  category: 'company',
})
@Injectable()
export class CartaService implements IScraper {
  private readonly logger = new Logger(CartaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Carta: fetching ${url}`);

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
        const id = `carta-${jobId}`;

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
            site: Site.CARTA,
            title,
            companyName: listing.company_name ?? 'Carta',
            // D-04: variant-2 modern US-region permalink subdomain —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/carta/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 10 padded in run
            // #276 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Carta: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Carta scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
