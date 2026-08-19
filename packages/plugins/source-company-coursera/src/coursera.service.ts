import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Coursera, Inc. — operator of the dominant massive-open-online-course
 * (MOOC) platform (founded by Andrew Ng and Daphne Koller in 2012 in
 * Mountain View, California; publicly traded on NYSE under ticker
 * `COUR` since the 2021 IPO; 205M+ registered learners as of March
 * 2026; partners with 375+ leading universities and industry partners
 * including Stanford, Yale, Google, IBM, and Meta) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `coursera` (the lowercase brand name; no whitespace transform
 * required since the brand is a single word; see Spec 068 § 10 D-05).
 * The wire `company_name` is the single-token bare brand `'Coursera'`
 * byte-for-byte.
 *
 * **Zero structural deviations from the Chime (Spec 059) template** —
 * making this the **first** Greenhouse-only company-direct plugin in
 * run-history to ship as a clean re-spin of a prior cohort plugin
 * with no per-axis deviations.
 *
 * Shared with Chime:
 *
 *   - **D-04 — wire-shape variant 2.** Coursera's tenant publishes its
 *     `absolute_url` on the modern US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/coursera/jobs/<id>` shape —
 *     the **fourteenth** plugin in the cohort to use variant 2 (after
 *     Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify, Postman,
 *     Webflow, Attentive, Intercom, Mixpanel, Scale AI, Cameo, and
 *     Carta). The fallback `jobUrl` constructor mirrors this
 *     byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Coursera's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;p&gt;&lt;strong&gt;About Coursera&lt;/strong&gt;&lt;/p&gt;
 *     &lt;p&gt;Coursera was launched in 2012 by Andrew Ng and Daphne
 *     Koller...`), so the plugin decodes entities BEFORE stripping
 *     tags. **Twenty-fourth** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Coursera'`
 *     byte-for-byte (the single-token bare brand name; no legal-
 *     entity suffix on the wire — distinct from the legal-entity
 *     name "Coursera, Inc." that may appear in older SEC filings or
 *     the NYSE ticker `COUR`); the plugin reads
 *     `listing.company_name` directly with `'Coursera'` as a
 *     defensive fallback. **Eighteenth cohort plugin to omit D-09**,
 *     returning to the single-word bare-brand wire form.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 8 wire titles in
 *     the run-278 probe carry trailing ASCII-space padding
 *     (`'Chief of Staff - CTO'`, `'Content Ingestion & Transformation
 *     Specialist'`, `'Degree Program Operations Specialist (NCR
 *     Region)'`, `'Degrees Success Manager'`, `'Director, Global
 *     Benefits'`, `'Senior Product Marketing Manager'`, `'Stock
 *     Compensation Accountant'`, `'VP, Corporate Development'`).
 *     The plugin emits `listing.title` byte-for-byte without a
 *     `.trim()`. **Sixth cohort plugin to omit D-10** —
 *     structurally analogous to Chime (Spec 059 § 10 D-10), Scale
 *     AI (Spec 064 § 10 D-10), Cameo (Spec 065 § 10 D-10), and
 *     Webflow (Spec 056). Distinct from the trim-applied cohort:
 *     Brex, Buildkite, ZoomInfo, Attentive, Elastic, Intercom,
 *     Mixpanel, Faire, Carta, and ClassPass.
 *
 *   - **D-11 — fully-clean department pass-through.** Coursera's
 *     wire department names are 0 of 8 padded (0 % pad rate). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the clean
 *     wire data; if Coursera adds padding upstream in the future,
 *     the pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/coursera/jobs';

@SourcePlugin({
  site: Site.COURSERA,
  name: 'Coursera',
  category: 'company',
})
@Injectable()
export class CourseraService implements IScraper {
  private readonly logger = new Logger(CourseraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Coursera: fetching ${url}`);

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
        const id = `coursera-${jobId}`;

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
            site: Site.COURSERA,
            title,
            companyName: listing.company_name ?? 'Coursera',
            // D-04: variant-2 modern US-region permalink subdomain —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/coursera/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 8 padded in run
            // #278 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Coursera: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Coursera scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
