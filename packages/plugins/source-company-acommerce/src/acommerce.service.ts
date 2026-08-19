import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * aCommerce — operator of the **dominant Southeast-Asian
 * end-to-end e-commerce enablement and brand-fulfilment
 * platform** providing brand-strategy / channel-management,
 * store operations, performance marketing, creative content
 * production, demand-and-supply planning, regional
 * warehousing-and-fulfilment, last-mile distribution,
 * customer service, and data-analytics services for global
 * consumer brands and retailers expanding across Southeast-
 * Asia (founded in 2013 by Paul Srivorakul and Tom
 * Srivorakul in Bangkok, Thailand; privately-held SEA-
 * headquartered direct-to-consumer enablement operator;
 * serves consumer-packaged-goods brands, fashion-and-beauty
 * brands, electronics brands, and multinational retailers in
 * Thailand, Indonesia, Singapore, Malaysia, and the
 * Philippines; ships brand-operations playbooks, regional
 * warehousing infrastructure, last-mile fulfilment networks,
 * performance-marketing engines, creative content studios,
 * and proprietary brand-management technology across the
 * Southeast-Asia e-commerce enablement / brand-fulfilment
 * segment — alongside peers Synagie, Luxasia, GHL Systems,
 * and regional logistics operators — with a hybrid
 * distributed workforce concentrated across Bangkok (HQ),
 * Jakarta, Manila / Taguig, Singapore, and Kuala Lumpur) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `acommerce` (wire `company_name ===
 * 'aCommerce'` — see Spec 180 § 10 D-09).
 *
 * **One structural deviation from the ACOG (Spec 179)
 * template** —
 *
 *   - **D-09 sub-axis:** acronym-by-initials slug derivation
 *     from a multi-token PascalCase + lowercase-connector
 *     wire form (`'American College of Obstetricians and
 *     Gynecologists'` 51 bytes — 6 wire-tokens, 4 PascalCase
 *     + 2 lowercase-connector; slug `acog` formed by sampling
 *     first letter of each PascalCase wire-token with
 *     connector-skip) → **single-token camelCase ONE-cap-at-
 *     byte-1 wire form** (`'aCommerce'` 9 bytes — single
 *     wire-token; byte 0 `'a'` lowercase, byte 1 `'C'`
 *     UPPERCASE (sole cap), bytes 2-8 `'ommerce'` all
 *     lowercase; slug `acommerce` is byte-for-byte lowercase
 *     of wire). **First cohort observation of (a) single-
 *     token camelCase classical wire form (lowercase-prefix
 *     + single-cap + lowercase-tail) AND (b) cap-at-byte-1-
 *     only D-09 sub-pattern.**
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acommerce/jobs/<id>`.
 *     **Seventy-ninth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-sixth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'aCommerce'`
 *      byte-for-byte (9 bytes). Single wire-token; byte 0
 *      `'a'` lowercase, byte 1 `'C'` UPPERCASE (sole cap),
 *      bytes 2-8 `'ommerce'` all lowercase (bytes 2='o',
 *      3='m', 4='m', 5='e', 6='r', 7='c', 8='e'). Slug is
 *      9-byte lowercase `acommerce` — formed by lowercasing
 *      byte 1 (`'C'` → `'c'`) and leaving the other 8 bytes
 *      unchanged. **127th cohort plugin to omit D-09.**
 *      **First cohort observation of (a) single-token
 *      camelCase classical wire form (lowercase-prefix +
 *      single-cap + lowercase-tail) AND (b) cap-at-byte-1-
 *      only D-09 sub-pattern.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     9 of 60 wire titles in the run-390 probe carry trailing
 *     ASCII-space padding (~15.0 % pad rate).
 *     **Eighty-third cohort plugin to apply D-10**.
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 13
 *     unique wire department names padded; wire
 *     `departments[0].name` flows through byte-for-byte.
 *     **107th cohort plugin with fully-clean department
 *     pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acommerce/jobs';

@SourcePlugin({
  site: Site.ACOMMERCE,
  name: 'aCommerce',
  category: 'company',
})
@Injectable()
export class AcommerceService implements IScraper {
  private readonly logger = new Logger(AcommerceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`aCommerce: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 9/60 wire titles
        // padded (~15.0 %) — e.g., `'Key Account Manager '`.
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
        const id = `acommerce-${jobId}`;

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
            site: Site.ACOMMERCE,
            title,
            // D-09 pass-through: wire `'aCommerce'` (single-
            // token camelCase ONE-cap-at-byte-1 co-form).
            companyName: listing.company_name ?? 'aCommerce',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acommerce/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/13 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`aCommerce: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`aCommerce scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
