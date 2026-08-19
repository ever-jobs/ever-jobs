import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Indigo Agriculture, Inc. — operator of the **agricultural-
 * microbiome / regenerative-farming platform pioneered around
 * the carbon-sequestration data model** (founded by Geoffrey
 * von Maltzahn, Ignacio Martinez, and Flagship Pioneering in
 * 2014 in Boston, MA; private since the 2022 Series F round
 * at ~$3.5B unicorn valuation; ships Indigo Carbon (carbon-
 * sequestration credits), Indigo Marketplace (grain trading),
 * and microbial seed-treatment products across the agtech /
 * regenerative-agriculture / climate-credits vertical —
 * alongside competitors Pivot Bio, Boomitra, Truterra, and
 * Nutrien Ag Solutions — with a hybrid distributed workforce
 * concentrated across Boston (HQ), Charleston SC, Memphis
 * TN, Buenos Aires, and Remote across the United States and
 * South America) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `indigo` (case-
 * symmetric with the wire `company_name === 'Indigo'`; see
 * Spec 157 § 10 D-09).
 *
 * **One structural deviation from the Lookout (Spec 083)
 * template** — D-04 sub-axis (variant 20 → variant 2
 * canonical Greenhouse host).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/indigo/jobs/<id>`.
 *     **Sixty-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirteenth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Indigo'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `indigo` after casefold). 0 of 1 padded.
 *     **One-hundred-and-fourth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 1 wire
 *     titles in the run-367 probe carry pad bytes. The
 *     plugin emits `listing.title` byte-for-byte without a
 *     `.trim()`. **Thirty-second cohort plugin to omit D-10**.
 *     (Note: low-volume sample (1 listing) — D-10
 *     determination is provisional based on observed wire
 *     cleanliness.)
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 1
 *     wire department names padded across 1 unique department
 *     (`'People'` — clean single-token form). **Ninetieth
 *     cohort plugin** with fully-clean department pass-
 *     through — **the cohort crosses the 90-plugin D-11-
 *     omission threshold at this run.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/indigo/jobs';

@SourcePlugin({
  site: Site.INDIGO,
  name: 'Indigo',
  category: 'company',
})
@Injectable()
export class IndigoService implements IScraper {
  private readonly logger = new Logger(IndigoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Indigo: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/1 wire titles padded (no .trim()
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
        const id = `indigo-${jobId}`;

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
            site: Site.INDIGO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Indigo',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/indigo/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/1 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Indigo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Indigo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
