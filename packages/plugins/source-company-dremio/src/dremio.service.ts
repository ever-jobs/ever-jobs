import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Dremio Corporation — operator of the **dominant data-
 * lakehouse + open-table-format query-engine platform
 * pioneered around the SQL-on-Iceberg / Apache-Arrow-
 * acceleration / data-mesh-without-data-movement data model**
 * (founded by Tomer Shiran and Jacques Nadeau (former Apache
 * Drill PMC chair) in 2015 in Mountain View, California;
 * raised ~$415M across rounds at peak ~$2B valuation in
 * January 2022 led by Sapphire Ventures and Adams Street
 * Partners; ships Dremio Cloud (managed lakehouse), Dremio
 * Software, Dremio Sonar (SQL query engine), Dremio Arctic
 * (Apache-Iceberg catalog with Nessie git-like versioning),
 * and Apache-Iceberg + Apache-Arrow + Apache-Parquet + Apache-
 * Polaris contributions across the data-lakehouse / data-mesh
 * / SQL-on-Iceberg / open-table-format segment — alongside
 * competitors Snowflake, Databricks, Starburst (Trino),
 * Microsoft Fabric, Google BigQuery, AWS Athena, and Tabular
 * — with a hybrid distributed workforce concentrated across
 * Mountain View (HQ), Bangalore, London, Tel Aviv, and Remote
 * across the United States, India, the United Kingdom, the
 * European Union, and Israel) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `dremio`
 * (case-symmetric with the wire `company_name === 'Dremio'`;
 * see Spec 128 § 10 D-05).
 *
 * **One structural deviation from the Fastly (Spec 113)
 * template** — D-04 wire-shape variant 33 (first cohort
 * plugin to use variant 33; **first cohort observation of
 * HTTPS-scheme `www.`-prefixed brand-domain `/careers/job-
 * postings/` query-only-id**). Variant 33 is sister to
 * Fastly's variant 30 (HTTPS + www + query-only-id, different
 * path: `/about/jobs/apply` vs `/careers/job-postings/`).
 * All other axes share with Fastly: D-08 entity-decode-then-
 * tag-strip, D-09 omitted with case-symmetric bare-brand
 * wire, D-10 applied (Dremio 2/12 padded ~16.7 %), D-11
 * omitted with first-cohort sentence-style catchall dept
 * observation (`'Unsure what to apply for? ...'`).
 *
 *   1. **D-04 — wire-shape variant 33 (HTTPS-scheme `www.`-
 *      prefixed brand-domain `/careers/job-postings/` query-
 *      only-id — first cohort observation).** Dremio publishes
 *      its `absolute_url` on a **previously-unobserved** shape
 *      `https://www.dremio.com/careers/job-postings/?gh_jid=<id>`
 *      with four sub-axes:
 *      a) **HTTPS scheme.**
 *      b) **`www.`-prefixed brand-domain** — same `www.`
 *         prefix as variants 16, 19, 20, 22, 30, 32.
 *      c) **`/careers/job-postings/` path** with **trailing
 *         slash** — distinct from variant 30's `/about/jobs/
 *         apply` (no trailing slash) and variant 32's
 *         `/careers/current-openings/job`.
 *      d) **Query-only id** (`?gh_jid=<id>` — single param).
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 33** — the **thirty-sixth distinct wire-shape
 *      variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/dremio/jobs/<id>`.
 *
 * Shared with Fastly:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Dremio'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `dremio`). **Seventy-fifth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 12 wire titles in the run-338 probe carry trailing
 *     ASCII-space padding (~16.7 % pad rate; e.g. `'Senior
 *     Product Manager '`, `'Staff Software Engineer - Platform
 *     & Integrations '`). **Forty-eighth cohort plugin to
 *     apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with
 *     FIRST-COHORT sentence-style catchall dept observation.**
 *     0 of 12 wire department names padded across 7 unique
 *     departments (`'Engineering'`, `'Marketing'`, `'Presales'`,
 *     `'Product'`, `'Sales'`, `'Security'`, plus 1 **sentence-
 *     style catchall**: `'Unsure what to apply for? No worries!
 *     Submit your resume here.'` — first cohort observation of
 *     a question-mark / exclamation-point bearing dept name;
 *     standard pass-through preserves byte-for-byte). **Sixty-
 *     seventh cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/dremio/jobs';

@SourcePlugin({
  site: Site.DREMIO,
  name: 'Dremio',
  category: 'company',
})
@Injectable()
export class DremioService implements IScraper {
  private readonly logger = new Logger(DremioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Dremio: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/12 wire titles
        // padded (~16.7 %).
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
        const id = `dremio-${jobId}`;

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
            site: Site.DREMIO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Dremio',
            // D-04: wire `absolute_url` flows through (variant
            // 33 — HTTPS `www.dremio.com/careers/job-postings/?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/dremio/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/12 wire departments padded
            // (sentence-style catchall pass-through preserved
            // byte-for-byte).
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Dremio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Dremio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
