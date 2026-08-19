import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cameo, Inc. — celebrity-personalised-video marketplace vendor
 * (operator of Cameo Marketplace, Cameo for Business, Cameo Calls,
 * Cameo Kids, Cameo Direct, and Cameo Pass) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `cameo` (the lowercase brand name; no whitespace transform required
 * since the brand is a single word; see Spec 065 § 10 D-05). The wire
 * `company_name` is the single-token bare brand `'Cameo'` byte-for-
 * byte.
 *
 * One structural deviation from the Scale AI (Spec 064) template:
 *
 *   1. **D-11 partial-pad department pass-through.** Scale AI's wire
 *      department names are all trim-clean. Cameo carries 1 of 3 wire
 *      department names with a trailing ASCII-space pad byte
 *      (`'Cameo for Business '` — the second-listing department; the
 *      other two are clean). The plugin emits the wire
 *      `departments[0].name` byte-for-byte (no department-name trim —
 *      the pass-through preserves byte-fidelity to the wire shape).
 *      First cohort plugin to ship a wire department-name with
 *      trailing ASCII-space padding pass-through observability.
 *
 * Shared with Scale AI:
 *
 *   - **D-04 — wire-shape variant 2.** Cameo's tenant publishes its
 *     `absolute_url` on the modern US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/cameo/jobs/<id>` shape — the
 *     **thirteenth** plugin in the cohort to use variant 2 (after
 *     Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify, Postman,
 *     Webflow, Attentive, Intercom, Mixpanel, and Scale AI). The
 *     fallback `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Cameo's `content` is
 *     HTML-entity-encoded (`&lt;p&gt;At Cameo, we make impossible
 *     connections possible...`), so the plugin decodes entities
 *     BEFORE stripping tags. **Twenty-first** plugin in the cohort
 *     to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Cameo'`
 *     byte-for-byte (the single-token bare brand name; no legal-
 *     entity suffix); the plugin reads `listing.company_name`
 *     directly with `'Cameo'` as a defensive fallback. **Fifteenth
 *     cohort plugin to omit D-09**, returning to the single-word
 *     bare-brand wire form (Mixpanel `'Mixpanel'`, Faire `'Faire'`,
 *     Intercom `'Intercom'`, Elastic `'Elastic'`, Webflow
 *     `'Webflow'`, Attentive `'Attentive'`, Postman `'Postman'`,
 *     Netlify `'Netlify'`, Mercury `'Mercury'`, Buildkite
 *     `'Buildkite'`, CircleCI `'CircleCI'`, Toast `'Toast'`, plus the
 *     Ramp Network slug-collapse case where the wire `company_name
 *     === 'Ramp'` was single-word despite the slug being
 *     `rampnetwork`) — distinct from Scale AI's first-of-its-kind
 *     multi-token bare-brand wire `company_name === 'Scale AI'`.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 3 wire titles in
 *     the run-275 probe carry trailing ASCII-space padding
 *     (`'Automation Engineer'`, `'Business Development Representative
 *     - Cameo for Business'`, `'Summer Internship (2026)- Talent/
 *     Creator Acquisition'`). The plugin emits `listing.title` byte-
 *     for-byte without a `.trim()`. Structurally analogous to Chime
 *     (Spec 059 § 10 D-10) and Scale AI (Spec 064 § 10 D-10) — both
 *     also omitted, distinct from the trim-applied cohort: Brex,
 *     Buildkite, ZoomInfo, Attentive, Elastic, Intercom, Mixpanel,
 *     and Faire.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/cameo/jobs';

@SourcePlugin({
  site: Site.CAMEO,
  name: 'Cameo',
  category: 'company',
})
@Injectable()
export class CameoService implements IScraper {
  private readonly logger = new Logger(CameoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cameo: fetching ${url}`);

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
          // D-11: department search uses the wire-padded form;
          // case-insensitive substring match remains semantically
          // correct against `'Cameo for Business '` because
          // `'business'` is a substring of `'cameo for business '`
          // after lowercasing.
          const deptMatch = (listing.departments?.[0]?.name ?? '')
            .toLowerCase()
            .includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `cameo-${jobId}`;

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
            site: Site.CAMEO,
            title,
            companyName: listing.company_name ?? 'Cameo',
            // D-04: variant-2 modern US-region permalink subdomain —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/cameo/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; preserves trailing pad byte if present.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Cameo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cameo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
