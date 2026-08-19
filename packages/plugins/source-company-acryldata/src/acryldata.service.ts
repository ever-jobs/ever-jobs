import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Acryl Data, Inc. — operator of the **dominant managed open-
 * source metadata-platform vendor**, the corporate steward of
 * the open-source `DataHub` end-to-end data-discovery,
 * observability, and governance platform — providing a hosted
 * SaaS edition (`Acryl DataHub`), enterprise data-catalog,
 * column-and-table-level data lineage, schema-and-quality
 * monitoring, role-based access governance, business-glossary
 * curation, and developer-tooling services for global
 * enterprise customers (founded in 2020 by Swaroop Jagadish,
 * Shirshanka Das, Mars Lan and Kerem Sahin in Palo Alto,
 * California; privately-held metadata-platform vendor backed
 * by 8VC, LinkedIn, Insight Partners, and DBC Venture
 * Partners; serves enterprise customers across financial
 * services, retail, technology, and media verticals; ships
 * Acryl DataHub Cloud, DataHub Open Source, Iceberg-and-
 * Trino-aware ingestion, MCP-style metadata streaming,
 * observability assertions, and column-level lineage across
 * the enterprise data-catalog / metadata-management segment
 * — alongside peers Atlan, Collibra, Alation, Castor, and
 * data.world — with a hybrid distributed workforce
 * concentrated across Palo Alto (HQ), Europe Remote, US
 * Remote, West Coast Remote, Bengaluru, and Remote Global) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `acryldata` (wire
 * `company_name === 'DataHub'` — see Spec 184 § 10 D-09).
 *
 * **One structural deviation from the Acquia (Spec 182)
 * template** —
 *
 *   - **D-09 sub-axis:** case-symmetric bare-brand single-
 *     token PascalCase wire form with **slug derived byte-for-
 *     byte from wire** (Acquia: wire `'Acquia'` → slug
 *     `acquia`; lowercase-of-wire derivation) → **first cohort
 *     observation of a slug-not-derived-from-wire-company_name
 *     sub-form**: wire `company_name === 'DataHub'` 7 bytes
 *     TWO-cap PascalCase single-token (caps at bytes 0 and 4)
 *     but slug `acryldata` 9 bytes is **not** lowercase-of-
 *     wire — the slug is derived from the **corporate name**
 *     `'Acryl Data'` (10-byte case-symmetric two-token
 *     PascalCase + ASCII-space; first token `'Acryl'` 5 bytes
 *     PascalCase cap-at-0 + second token `'Data'` 4 bytes
 *     PascalCase cap-at-0 + 1 internal ASCII space stripped
 *     to yield 9-byte lowercase slug `acryldata`), while the
 *     wire emits the **product-line brand name** `'DataHub'`.
 *     First cohort observation of (a) slug-from-corporate-
 *     name + wire-as-product-brand mismatch AND (b) two-token
 *     space-strip slug derivation that the wire `company_name`
 *     does **not** participate in.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acryldata/jobs/<id>`.
 *     **Eighty-third** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-fortieth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'DataHub'`
 *      byte-for-byte (7 bytes, TWO-cap PascalCase single-token
 *      caps at byte 0 and byte 4). **131st cohort plugin to
 *      omit D-09.** **First cohort observation of slug-from-
 *      corporate-name + wire-as-product-brand mismatch.**
 *
 *   4. **D-10 — omitted (clean pass-through).** 0 of 9 wire
 *      titles in the run-394 probe carry trailing ASCII-space
 *      padding; emit byte-for-byte without `.trim()`.
 *      **Forty-fourth cohort plugin to omit D-10**.
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 3 unique
 *      wire department names padded; wire
 *      `departments[0].name` flows through byte-for-byte.
 *      **111th cohort plugin with fully-clean department
 *      pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acryldata/jobs';

@SourcePlugin({
  site: Site.ACRYLDATA,
  name: 'Acryl Data',
  category: 'company',
})
@Injectable()
export class AcryldataService implements IScraper {
  private readonly logger = new Logger(AcryldataService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Acryldata: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted (clean pass-through): 0/9 wire titles
        // padded — emit byte-for-byte without `.trim()`.
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
        const id = `acryldata-${jobId}`;

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
            site: Site.ACRYLDATA,
            title,
            // D-09 pass-through: wire `'DataHub'` (TWO-cap
            // PascalCase single-token; slug derived from
            // corporate name `'Acryl Data'`, not from wire).
            companyName: listing.company_name ?? 'DataHub',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acryldata/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/3 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Acryldata: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Acryldata scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
