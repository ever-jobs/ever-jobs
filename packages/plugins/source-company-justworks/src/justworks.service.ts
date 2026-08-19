import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Justworks, Inc. — operator of the **dominant SMB-PEO +
 * all-in-one HR platform pioneered around the certified-
 * professional-employer-organization-as-a-service data
 * model** (founded by Isaac Oates in 2012 in New York City;
 * raised ~$143M across rounds at peak ~$2B valuation in
 * February 2022 led by Tiger Global Management; ships
 * Justworks PEO Plus (payroll + benefits + HR + compliance +
 * workers' comp under co-employer model), Justworks Payroll
 * (standalone payroll for non-PEO customers), Justworks Time
 * Tracking, Justworks Hours, and Justworks International
 * Contractor Payments + EOR services across the SMB-PEO /
 * payroll-HR / employer-of-record segment — alongside
 * competitors Gusto, TriNet, Insperity, Rippling, ADP
 * TotalSource, Paychex, Deel, Remote, Velocity Global, and
 * Sequoia One — with a hybrid distributed workforce
 * concentrated across New York City (HQ), Tampa, Aveiro
 * (Portugal), London, and Remote across the United States,
 * Portugal, the United Kingdom, and the European Union) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `justworks` (case-symmetric with the wire
 * `company_name === 'Justworks'`; see Spec 129 § 10 D-05).
 *
 * **Zero structural deviations from the Descript (Spec 112)
 * template** — making this the **thirtieth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin and the **sixth** plugin to use **wire-shape variant
 * 10** (legacy hosted-board apex). All five primary axes share
 * with Descript, with a **first-cohort D-10 sub-axis
 * observation** (double-trailing-space pad form):
 *
 *   - **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/justworks/jobs/<id>?gh_jid=<id>`.
 *     **Sixth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, Flexport, Braze, Descript).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Justworks'` byte-for-byte (9 bytes —
 *     fully clean, case-symmetric with the lowercase 9-byte
 *     slug `justworks`). **Seventy-sixth cohort plugin to
 *     omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied with FIRST-COHORT
 *     double-trailing-space pad form.** 5 of 82 wire titles
 *     in the run-339 probe carry trailing ASCII-space padding
 *     (~6.1 % pad rate, all trailing-only) — but **one
 *     carries DOUBLE trailing space** (`'Overnight Customer
 *     Support Advocate (Remote)  '` — 2 spaces). **First
 *     cohort observation of multi-byte trailing-pad form** in
 *     D-10. The plugin's `.trim()` operation strips both 1-
 *     space and 2-space pads transparently. **Forty-ninth
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 82
 *     wire department names padded across 17 unique departments
 *     (`'Corporate & Finance'`, `'Customer Success'`,
 *     `'Customer Success, International Products'`,
 *     `'Engineering'`, `'IT'`, `'Legal & Compliance'`,
 *     `'Marketing'`, `'Operations, Benefits'`, `'Operations,
 *     Payments & Tax'`, `'People'`, `'Product'`, `'Product
 *     Design'`, plus 5 others — clean multi-token forms with
 *     internal whitespace, ampersands, and commas). **Sixty-
 *     eighth cohort plugin** with fully-clean department pass-
 *     through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/justworks/jobs';

@SourcePlugin({
  site: Site.JUSTWORKS,
  name: 'Justworks',
  category: 'company',
})
@Injectable()
export class JustworksService implements IScraper {
  private readonly logger = new Logger(JustworksService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Justworks: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied with first-cohort double-trailing-space
        // sub-axis: 5/82 wire titles padded (~6.1 %); one
        // carries DOUBLE trailing space. `.trim()` handles
        // both byte-counts.
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
        const id = `justworks-${jobId}`;

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
            site: Site.JUSTWORKS,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Justworks',
            // D-04: wire `absolute_url` flows through (variant
            // 10 — legacy hosted-board apex
            // `boards.greenhouse.io/justworks/jobs/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/justworks/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/82 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Justworks: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Justworks scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
