import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Starburst Data, Inc. — operator of the **dominant
 * enterprise-distribution Trino-managed-platform pioneered
 * around the SQL-federation-across-data-lakes / connect-to-
 * 50+-data-sources / Iceberg-native-query-engine data model**
 * (founded by Justin Borgman and Matt Fuller in 2017 in
 * Boston — inheriting the original Apache Drill / Presto
 * founding team of Martin Traverso, Dain Sundstrom, David
 * Phillips (creators of Presto at Facebook); raised ~$414M
 * across rounds at peak ~$3.35B valuation in February 2022
 * led by Andreessen Horowitz; ships Starburst Galaxy (managed
 * Trino SaaS), Starburst Enterprise (self-hosted Trino),
 * Starburst Stargate (cross-cluster federation), Starburst
 * Warp Speed (autonomous query acceleration), and Apache
 * Iceberg + Trino + Hive contributions across the data-
 * federation / SQL-on-data-lakes / enterprise-Trino segment —
 * alongside competitors Dremio, Snowflake, Databricks,
 * Microsoft Fabric, Google BigQuery, AWS Athena, and Tabular
 * — with a hybrid distributed workforce concentrated across
 * Boston (HQ), Warsaw (Poland), London, and Remote across
 * the United States, Poland, the United Kingdom, and the
 * European Union) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `starburst` (case-
 * symmetric with the wire `company_name === 'Starburst'`;
 * see Spec 134 § 10 D-05).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **thirty-second** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. **Run #344 closes out the eighth fresh
 * probe sweep** — Starburst is the 15th and last candidate
 * from the run-330 pool. All five primary axes share with
 * Doximity:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/starburst/jobs/<id>`.
 *     **Forty-ninth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninetieth** plugin to apply D-08 — **the cohort
 *     crosses the 90-plugin D-08-application threshold at
 *     this run**.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Starburst'` byte-for-byte (9 bytes —
 *     fully clean, case-symmetric with the lowercase 9-byte
 *     slug `starburst`). **Eighty-first cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     6 of 26 wire titles in the run-344 probe carry trailing
 *     ASCII-space padding (~23.1 % pad rate; e.g. `'Executive
 *     Assistant '`, `'Partner Solution Architect '`, `'Sales
 *     Development Representative '`, plus 3 others). **Fifty-
 *     fourth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 26
 *     wire department names padded across 11 unique departments
 *     (`'Engineering'`, `'Enterprise Sales'`, `'Executive
 *     Operations'`, `'GTM'`, `'IT'`, `'Marketing'`, `'Presales'`,
 *     `'Product'`, `'Professional Services'`, `'Sales
 *     Development'`, `'Support'` — clean multi-token forms with
 *     internal whitespace). **Seventy-second cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/starburst/jobs';

@SourcePlugin({
  site: Site.STARBURST,
  name: 'Starburst',
  category: 'company',
})
@Injectable()
export class StarburstService implements IScraper {
  private readonly logger = new Logger(StarburstService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Starburst: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 6/26 wire titles
        // padded (~23.1 %).
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
        const id = `starburst-${jobId}`;

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
            site: Site.STARBURST,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Starburst',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/starburst/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/26 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Starburst: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Starburst scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
