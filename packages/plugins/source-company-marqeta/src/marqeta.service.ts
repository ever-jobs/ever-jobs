import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Marqeta, Inc. — operator of the dominant modern card-issuing
 * platform pioneered around the open-API embedded-payments-and-
 * instant-funds-disbursement data model (founded by Jason Gardner
 * in 2010 in Oakland, CA; IPO'd on NASDAQ as `MQ` in June 2021
 * at a $14B valuation; ships a B2B card-issuing + program-
 * management platform across the embedded-payments segment —
 * alongside competitors Stripe Issuing, Lithic, Galileo, Adyen
 * Issuing, and i2c — with a hybrid distributed workforce
 * concentrated across Oakland, London, Singapore, and Remote
 * across the United States, Europe, and Asia-Pacific) —
 * publishes its consolidated careers board through Greenhouse at
 * the bare slug `marqeta` (the lowercase brand name; case-
 * symmetric with the wire `company_name === 'Marqeta'`; see Spec
 * 084 § 10 D-05). The wire `company_name` is the literal single-
 * token bare-brand string `'Marqeta'` byte-for-byte (7 bytes;
 * case-symmetric with the lowercase slug).
 *
 * **Zero structural deviations from the Calendly (Spec 080)
 * template** — making this the **fifth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin of a prior cohort plugin with no per-axis deviations
 * (after Coursera off Chime at run #278, Flexport off Faire at
 * run #280, and Glossier off Flexport at run #282). All axes
 * share with Calendly: D-04 wire-shape variant 2 (canonical
 * Greenhouse host), D-08 entity-decode-then-tag-strip, D-09
 * omitted with case-symmetric bare-brand wire, D-10 applied
 * (Marqeta 2/33 padded ~6.1 %; Calendly 1/20 padded ~5.0 % —
 * near-identical pad rate), D-11 fully-clean department pass-
 * through.
 *
 * Shared with Calendly:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     Marqeta's tenant publishes its `absolute_url` on the
 *     canonical Greenhouse variant-2 shape
 *     `https://job-boards.greenhouse.io/marqeta/jobs/<id>` —
 *     the baseline shape used by the majority of cohort plugins.
 *     **Nineteenth** plugin in the cohort to use canonical
 *     variant 2 (after Vercel, Affirm, Gusto, Mercury, Buildkite,
 *     Netlify, Postman, Webflow, Attentive, Intercom, Mixpanel,
 *     Scale AI, Cameo, Carta, Honeycomb, MasterClass, Maven
 *     Clinic, Calendly, and DataCamp).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Marqeta's `content`
 *     is HTML-entity-encoded (`&lt;p&gt;&lt;span style=&quot;
 *     font-size: 12pt;&quot;&gt;As Marqeta&#8217;s&amp;nbsp;
 *     &lt;strong&gt;CX Manager,&lt;/strong&gt;...`), so the
 *     plugin decodes entities BEFORE stripping tags. **Fortieth**
 *     plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Marqeta'` byte-for-byte (the single-
 *     token bare brand name; case-symmetric with the lowercase
 *     slug `marqeta`); no legal-entity suffix on the wire —
 *     distinct from the legal-entity name "Marqeta, Inc." that
 *     appears in current SEC filings under NASDAQ ticker `MQ`.
 *     The plugin reads `listing.company_name` directly with
 *     `'Marqeta'` as a defensive fallback. **Thirty-third
 *     cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 2 of 33 wire titles
 *     in the run-294 probe carry trailing ASCII-space padding
 *     (`'Group Product Manager, Fraud '`, `'Senior Director,
 *     Global Strategic Partnerships '` — both single-trailing-
 *     space-padded; ~6.1 % pad rate, in line with Calendly's
 *     1/20 ~5.0 % rate). The plugin applies `.trim()` to the
 *     wire `title` before downstream filters and emit.
 *     **Twentieth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** Marqeta's
 *     wire department names are 0 of 33 padded (0 % pad rate —
 *     `'Risk Operations'`, `'Marketing - General'`, `'Credit
 *     Engineering'`, `'Risk, Fraud, Disputes Product'`,
 *     `'CyberSecurity'`, `'Core Product'` — clean multi-token
 *     forms with internal whitespace, hyphens, and commas). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()`. **Thirtieth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/marqeta/jobs';

@SourcePlugin({
  site: Site.MARQETA,
  name: 'Marqeta',
  category: 'company',
})
@Injectable()
export class MarqetaService implements IScraper {
  private readonly logger = new Logger(MarqetaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Marqeta: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 2/33 padded in run-294 probe.
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
        const id = `marqeta-${jobId}`;

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
            site: Site.MARQETA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Marqeta',
            // D-04: wire `absolute_url` flows through (variant 2);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/marqeta/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/33 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Marqeta: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Marqeta scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
