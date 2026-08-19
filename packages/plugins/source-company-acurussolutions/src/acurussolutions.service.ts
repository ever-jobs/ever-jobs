import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Acurus Solutions Private Limited — operator of the
 * **Bengaluru-HQ full-service healthcare revenue-cycle-
 * management (RCM) outsourcing platform** for U.S. hospital
 * and physician-group clients across the AR-analysis /
 * charge-posting / coding / denial-management / payment-
 * posting / pre-authorization / scribe-services verticals
 * (Karnataka, India private-limited-company; operates the
 * **Central Billing Office**, **Health Information
 * Management**, **People**, **Revenue Cycle Management**,
 * and **Scribe** delivery divisions across the healthcare-
 * BPO / RCM-outsourcing segment — alongside peers R1 RCM,
 * Optum, Cognizant TriZetto Healthcare Solutions, and
 * Conifer Health Solutions — with the bulk of FY2024 ATS
 * postings concentrated in the Revenue Cycle Management
 * vertical) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `acurussolutions` (15
 * bytes; wire `company_name === 'Acurus Solutions Private
 * Limited'` 32 bytes; see Spec 186 § 10 D-09).
 *
 * **One structural deviation from the Acumen (Spec 185)
 * template** — D-09 sub-axis: case-symmetric bare-brand
 * single-token PascalCase 6-byte → first cohort observation
 * of 2-token-prefix PascalCase slug-truncation from 4-token
 * all-PascalCase wire form with corporate-legal-suffix-drop
 * (drop `'Private Limited'` legal-entity suffix; keep first-
 * 2-tokens `'Acurus Solutions'` 16 bytes; space-strip +
 * lowercase → 15-byte slug `acurussolutions`).
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acurussolutions/jobs/<id>`.
 *     **Eighty-fifth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-forty-second** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'Acurus
 *      Solutions Private Limited'` byte-for-byte (32 bytes,
 *      4-token PascalCase + 3 ASCII spaces; every wire
 *      token PascalCase cap-at-byte-0-only). Slug
 *      `acurussolutions` 15 bytes derives from first-2-
 *      tokens `'Acurus Solutions'` (drop `'Private Limited'`
 *      corporate-legal-entity suffix), then space-strip +
 *      lowercase. **First cohort observation of 2-token-
 *      prefix PascalCase slug-truncation D-09 sub-form.**
 *      **First cohort observation of corporate-legal-
 *      suffix-drop slug-truncation.** **First cohort
 *      observation of 4-token all-PascalCase wire form with
 *      slug-truncation D-09 sub-form.** **One-hundred-and-
 *      thirty-third cohort plugin to omit D-09.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 12 wire titles in the run-396 probe carries
 *     trailing ASCII-space padding (~8.3 % pad rate,
 *     trailing-only). **Eighty-sixth cohort plugin to apply
 *     D-10.**
 *
 *   5. **D-11 — fully-clean department pass-through.** 0 of 5
 *     unique wire department names padded (`'Central Billing
 *     Office'`, `'Health Information Management'`,
 *     `'People'`, `'Revenue Cycle Management'`, `'Scribe'`).
 *     Pass-through preserves byte-for-byte. **One-hundred-
 *     and-thirteenth cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acurussolutions/jobs';

@SourcePlugin({
  site: Site.ACURUSSOLUTIONS,
  name: 'Acurus Solutions',
  category: 'company',
})
@Injectable()
export class AcurussolutionsService implements IScraper {
  private readonly logger = new Logger(AcurussolutionsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AcurusSolutions: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/12 wire titles
        // padded (~8.3 %).
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
        const id = `acurussolutions-${jobId}`;

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
            site: Site.ACURUSSOLUTIONS,
            title,
            // D-09 pass-through: wire `'Acurus Solutions
            // Private Limited'` (4-token PascalCase + 3
            // ASCII spaces).
            companyName: listing.company_name ?? 'Acurus Solutions Private Limited',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acurussolutions/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/5 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`AcurusSolutions: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AcurusSolutions scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
