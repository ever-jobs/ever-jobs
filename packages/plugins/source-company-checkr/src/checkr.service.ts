import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Checkr, Inc. — operator of the **dominant API-driven
 * background-screening + identity-verification platform
 * pioneered around the people-trust-as-a-service data model**
 * (founded by Daniel Yanisse and Jonathan Perichon in 2014 in
 * San Francisco; raised ~$679M across rounds at peak ~$5B
 * valuation in September 2021 led by Tiger Global Management
 * and T. Rowe Price; ships Checkr Background Checks (criminal
 * / MVR / drug / employment / education verifications),
 * CheckrPay, Continuous Crime Monitoring, Adverse Action
 * workflows, Truework income / employment verification
 * (acquired November 2024 for ~$200M), and CheckrX (FCRA-
 * compliant tenant-facing screening) across the background-
 * screening / identity-verification / HR-tech segment —
 * alongside competitors Sterling, HireRight, Accurate
 * Background, GoodHire, and First Advantage — with a hybrid
 * distributed workforce concentrated across San Francisco
 * (HQ) and Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `checkr` (case-symmetric with the wire `company_name
 * === 'Checkr'`; see Spec 123 § 10 D-05).
 *
 * **Zero structural deviations from the Otter (Spec 116)
 * template** — making this the **twenty-sixth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Otter:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/checkr/jobs/<id>`.
 *     **Forty-second** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Checkr'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `checkr`). **Seventieth cohort plugin to omit D-09
 *     — the cohort crosses the 70-plugin D-09-omission
 *     threshold at this run**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 65 wire titles in the run-333 probe carry trailing
 *     ASCII-space padding (~3.1 % pad rate; e.g.
 *     `'Implementation Manager, Customer Success '`, `'Senior
 *     Python Engineer, Truework '`). **Forty-fifth cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 65
 *     wire department names padded across 13 unique departments
 *     (`'CheckrX'`, `'Customer Success'`, `'Engineering'`,
 *     `'Finance'`, `'Implementations'`, `'Information
 *     Technology'`, `'Legal & Compliance'`, `'Marketing'`,
 *     `'Operations'`, `'People'`, `'Product'`, `'Revenue
 *     Operations'`, `'Sales'` — clean multi-token forms with
 *     internal whitespace and ampersands; `'CheckrX'` carries
 *     the embedded brand-name dept naming convention as an
 *     observability sub-axis). **Sixty-third cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/checkr/jobs';

@SourcePlugin({
  site: Site.CHECKR,
  name: 'Checkr',
  category: 'company',
})
@Injectable()
export class CheckrService implements IScraper {
  private readonly logger = new Logger(CheckrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Checkr: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/65 wire titles
        // padded (~3.1 %).
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
        const id = `checkr-${jobId}`;

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
            site: Site.CHECKR,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Checkr',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/checkr/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/65 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Checkr: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Checkr scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
