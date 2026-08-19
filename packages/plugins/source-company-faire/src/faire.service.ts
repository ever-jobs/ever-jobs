import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Faire Wholesale, Inc. — B2B wholesale-marketplace platform vendor
 * (operator of Faire Marketplace, Faire Direct, Open With Faire, Faire
 * Insider, and Faire Logistics) — publishes its consolidated careers
 * board through Greenhouse at the bare `faire` slug (no asymmetry; see
 * Spec 063 § 10 D-05).
 *
 * Two structural deviations from the Chime (Spec 059) template:
 *
 *   1. **D-09 omitted.** Chime pinned `companyName === 'Chime'` as a
 *      string literal because its wire `company_name` carried the
 *      legal-entity suffix `'Chime Financial, Inc'`. Faire's wire
 *      `company_name` is `'Faire'` byte-for-byte (no legal-entity
 *      suffix on the wire — distinct from the legal-entity name
 *      "Faire Wholesale, Inc." that appears in SEC filings). The
 *      plugin reads `listing.company_name` directly with `'Faire'` as
 *      a defensive fallback. Thirteenth cohort plugin to omit D-09
 *      against a single-word bare-brand wire `company_name`.
 *
 *   2. **D-10 applied.** Chime's titles were all trim-clean. Faire's
 *      wire titles include 3 of 72 (~4.2 %) with trailing ASCII-space
 *      padding (`'Production Designer, Brand '`, `'Senior Product
 *      Marketing Manager - Faire Pay '`, `'Staff Product Designer,
 *      Discovery Experience '` — confirmed via run-273 probe). The
 *      plugin applies `.trim()` to the wire `title` before downstream
 *      filters and emit. Eighth cohort plugin to apply D-10 (after
 *      Brex `Spec 047 § 10 D-10`, Buildkite `Spec 050 § 10 D-10`,
 *      ZoomInfo `Spec 057 § 10 D-10`, Attentive `Spec 058 § 10 D-10`,
 *      Elastic `Spec 060 § 10 D-10`, Intercom `Spec 061 § 10 D-10`,
 *      and Mixpanel `Spec 062 § 10 D-10`).
 *
 * Shared with Chime:
 *
 *   - **D-04 — wire-shape variant 10 fallback URL.** Faire's tenant
 *     publishes its `absolute_url` on the **legacy hosted-board** apex
 *     `https://boards.greenhouse.io/faire/jobs/<id>?gh_jid=<id>` —
 *     the bare `boards.greenhouse.io` host without the `job-` prefix,
 *     plus a trailing `?gh_jid=<id>` query suffix. Second plugin in the
 *     cohort to use variant 10 (after Chime; distinct from variant 2's
 *     modern US-region permalink subdomain `job-boards.greenhouse.io/
 *     <slug>/jobs/<id>` used by Vercel, Affirm, Gusto, Mercury,
 *     Buildkite, Netlify, Postman, Webflow, Attentive, Intercom, and
 *     Mixpanel).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Faire's `content` is
 *     HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;p&gt;&lt;strong&gt;About Faire&lt;/strong&gt;...`), so the
 *     plugin decodes entities BEFORE stripping tags. Nineteenth plugin
 *     in the cohort to apply D-08.
 *
 * Department pass-through preserves Faire's multi-word descriptive
 * department names (`'Customer Support Management'`, `'Engineering'`,
 * `'Product Design'`, `'Marketing'`, etc.) byte-for-byte (Spec 063 § 10
 * D-11) — partly distinct from Mixpanel's strict flat single-token
 * format and Chime's single-token format, but structurally permissive
 * of internal whitespace within a single department string.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/faire/jobs';

@SourcePlugin({
  site: Site.FAIRE,
  name: 'Faire',
  category: 'company',
})
@Injectable()
export class FaireService implements IScraper {
  private readonly logger = new Logger(FaireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Faire: fetching ${url}`);

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
        const id = `faire-${jobId}`;

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
            site: Site.FAIRE,
            title,
            companyName: listing.company_name ?? 'Faire',
            // D-04: variant-10 legacy hosted-board fallback —
            // `boards.greenhouse.io/<slug>/jobs/<id>?gh_jid=<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://boards.greenhouse.io/faire/jobs/${listing.id}?gh_jid=${listing.id}`,
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

      this.logger.log(`Faire: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Faire scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
