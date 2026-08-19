import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Acquia, Inc. — operator of the **dominant Drupal-based
 * open-source-cloud digital-experience-platform (DXP)
 * vendor** providing managed Drupal hosting, content-
 * management, personalization, customer-data-platform (CDP),
 * digital-asset-management (DAM), site-builder, and
 * developer-tooling services for global enterprise customers
 * (founded in 2007 by Dries Buytaert (creator of Drupal) and
 * Jay Batson in Boston, Massachusetts; privately-held Drupal-
 * cloud DXP vendor backed by Vista Equity Partners since
 * 2019; serves enterprise customers across financial-
 * services, government, retail, higher-education,
 * healthcare, and media verticals; ships Acquia Cloud
 * Platform, Acquia CDP, Acquia DAM, Acquia Personalization,
 * Acquia Campaign Studio, and Acquia Site Studio across the
 * enterprise DXP / Drupal-as-a-service segment) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `acquia` (wire `company_name === 'Acquia'` —
 * see Spec 182 § 10 D-09).
 *
 * **Zero structural deviations from the Coursera (Spec 068)
 * template** — clean re-spin of the canonical variant-2 +
 * D-08 + D-09/D-10/D-11 all-omitted profile.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acquia/jobs/<id>`.
 *     **Eighty-first** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-eighth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'Acquia'`
 *      byte-for-byte (6 bytes, case-symmetric PascalCase
 *      single-token, cap at byte 0 only). **129th cohort
 *      plugin to omit D-09.**
 *
 *   4. **D-10 — omitted (clean pass-through).** 0 of 17
 *      wire titles in the run-392 probe carry trailing
 *      ASCII-space padding; emit byte-for-byte without
 *      `.trim()`. **Forty-third cohort plugin to omit D-10**.
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 5
 *      unique wire department names padded; wire
 *      `departments[0].name` flows through byte-for-byte.
 *      **109th cohort plugin with fully-clean department
 *      pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acquia/jobs';

@SourcePlugin({
  site: Site.ACQUIA,
  name: 'Acquia',
  category: 'company',
})
@Injectable()
export class AcquiaService implements IScraper {
  private readonly logger = new Logger(AcquiaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Acquia: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted (clean pass-through): 0/17 wire titles
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
        const id = `acquia-${jobId}`;

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
            site: Site.ACQUIA,
            title,
            // D-09 pass-through: wire `'Acquia'` (case-
            // symmetric bare-brand PascalCase single-token).
            companyName: listing.company_name ?? 'Acquia',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acquia/jobs/${listing.id}`,
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

      this.logger.log(`Acquia: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Acquia scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
