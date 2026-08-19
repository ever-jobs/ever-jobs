import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Acumen, Inc. — operator of the **dominant patient-capital
 * impact-investing nonprofit pioneered around the Acumen Fund
 * data model** for catalytic equity-and-debt investments in
 * early-stage social enterprises across emerging markets
 * (founded by Jacqueline Novogratz in 2001 in New York City;
 * NYC-HQ 501(c)(3) nonprofit with a global footprint across
 * the United States, Latin America, and East / West Africa,
 * India, Pakistan, and Colombia; operates the **Acumen Fund**
 * (patient-capital investment vehicle), **Acumen Academy**
 * (leadership-development and Foundry incubator arm), and
 * **Acumen East Africa / West Africa / Latin America / South
 * Asia** regional investment teams across the impact-
 * investing / philanthropic-capital segment — alongside peers
 * Omidyar Network, Echoing Green, and Skoll Foundation — with
 * the bulk of FY2024 deployed capital concentrated in
 * agriculture, clean-energy, education, financial-inclusion,
 * healthcare, and workforce-development verticals across
 * emerging markets) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `acumen` (wire
 * `company_name === 'Acumen'`; see Spec 185 § 10 D-09).
 *
 * **Zero structural deviations from the Tatari (Spec 173)
 * template** — clean re-spin of the canonical variant-2 +
 * D-08 + D-09 omitted (case-symmetric bare-brand single-
 * token PascalCase 6-byte sub-form) + D-10 applied (trailing-
 * pad form) + D-11 omitted profile.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acumen/jobs/<id>`.
 *     **Eighty-fourth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-forty-first** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'Acumen'`
 *      byte-for-byte (6 bytes, case-symmetric PascalCase
 *      single-token, cap at byte 0 only). Slug `acumen` is
 *      byte-for-byte lowercase of wire. **One-hundred-and-
 *      thirty-second cohort plugin to omit D-09.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 9 wire titles in the run-395 probe carries
 *     trailing ASCII-space padding (~11.1 % pad rate,
 *     trailing-only — `'Compensation Consultant '`).
 *     **Eighty-fifth cohort plugin to apply D-10.**
 *
 *   5. **D-11 — fully-clean department pass-through.** 0 of 4
 *     unique wire department names padded (`'Acumen Academy'`,
 *     `'Executive Office'`, `'Investing'`, `'Talent'`).
 *     Pass-through preserves byte-for-byte. **One-hundred-and-
 *     twelfth cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acumen/jobs';

@SourcePlugin({
  site: Site.ACUMEN,
  name: 'Acumen',
  category: 'company',
})
@Injectable()
export class AcumenService implements IScraper {
  private readonly logger = new Logger(AcumenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Acumen: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/9 wire titles
        // padded (~11.1 %) — `'Compensation Consultant '`.
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
        const id = `acumen-${jobId}`;

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
            site: Site.ACUMEN,
            title,
            // D-09 pass-through: wire `'Acumen'` (case-
            // symmetric bare-brand PascalCase single-token).
            companyName: listing.company_name ?? 'Acumen',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acumen/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/4 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Acumen: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Acumen scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
