import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Founders Green Animal Hospital — operator of a **veterinary-
 * specialty animal-hospital + emergency / referral practice
 * pioneered around the multi-disciplinary companion-animal
 * clinical-care data model** (an independent veterinary
 * hospital practice; ships small-animal medicine, surgery,
 * emergency / critical care, dentistry, and rehabilitation
 * services across the consumer-veterinary / companion-animal-
 * care vertical) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `founders` (case-
 * asymmetric vs the wire `company_name === 'Founders Green
 * Animal Hospital'` — slug truncates the wire to the first
 * token only; see Spec 148 § 10 D-09).
 *
 * **One structural deviation from the BEAM (Spec 136)
 * template** — D-04 sub-axis (variant 2 → variant 10 legacy
 * hosted-board apex).
 *
 *   - **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/founders/jobs/<id>?gh_jid=<id>`.
 *     **Seventh** plugin in the cohort to use variant 10 after
 *     Chime, Faire, Flexport, Braze, Descript, and Justworks.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with THIRD-COHORT
 *     slug-truncation asymmetric wire form.** Wire
 *     `company_name === 'Founders Green Animal Hospital'`
 *     byte-for-byte (30 bytes — FOUR-token legal-entity name
 *     with internal whitespace). Slug `founders` is 8 bytes
 *     lowercase — matches the first token only; truncates 3
 *     trailing tokens (`Green Animal Hospital`). **Third
 *     cohort observation of slug-truncation D-09 sub-axis**
 *     after Oscar (Spec 133 — slug-extra-word, 1 token added
 *     beyond slug — `'Oscar Health'`) and BEAM (Spec 136 —
 *     slug-acronym-expansion — slug `beam` is acronym only,
 *     wire `'Bridge to Enter Advanced Mathematics (BEAM)'`
 *     43 bytes). Founders has the **largest slug-token-
 *     truncation factor in cohort to date** (4 tokens dropped
 *     beyond slug vs Oscar's 1 token added). **Ninety-fifth
 *     cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 3 wire
 *     titles in the run-358 probe carry pad bytes. The plugin
 *     emits `listing.title` byte-for-byte without a `.trim()`.
 *     **Twenty-ninth cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 3
 *     wire department names padded across 3 unique departments
 *     (`'Assistants'`, `'Reception'`, `'Technicians'` — clean
 *     single-token forms). Pass-through preserves byte-for-
 *     byte. **Eighty-third cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/founders/jobs';

@SourcePlugin({
  site: Site.FOUNDERS,
  name: 'Founders Green Animal Hospital',
  category: 'company',
})
@Injectable()
export class FoundersService implements IScraper {
  private readonly logger = new Logger(FoundersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Founders: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/3 wire titles padded (no .trim()
        // applied — wire is fully clean).
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
        const id = `founders-${jobId}`;

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
            site: Site.FOUNDERS,
            title,
            // D-09 omitted: slug-truncation asymmetric wire
            // form `'Founders Green Animal Hospital'`.
            companyName: listing.company_name ?? 'Founders Green Animal Hospital',
            // D-04: wire `absolute_url` flows through (variant 10).
            jobUrl:
              listing.absolute_url ??
              `https://boards.greenhouse.io/founders/jobs/${listing.id}?gh_jid=${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/3 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Founders: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Founders scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
