import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bridge to Enter Advanced Mathematics, Inc. (BEAM) —
 * operator of the **dominant US 501(c)(3)-nonprofit math-
 * enrichment program pioneered around the rigorous-math-via-
 * summer-program + year-round-pathway data model** (founded
 * by Daniel Zaharopol in 2011 in New York City; ships BEAM
 * Discovery (rising-7th-grade summer day-camp), BEAM Summer
 * Away (residential summer program for rising 8th graders),
 * BEAM Pathway (year-round 8th-12th-grade pathway through
 * STEM schools and college support), and BEAM Year-Round
 * (Saturday academic enrichment in NYC + LA) across the
 * gifted-and-talented / math-enrichment / STEM-pathway-for-
 * underserved-students segment — alongside competitors
 * AwesomeMath, Math Olympiad Summer Program (MOP), Stanford
 * Math Camp (SUMaC), PROMYS at Boston University, HCSSiM at
 * Hampshire College, and the Ross Mathematics Program — with
 * a hybrid distributed workforce concentrated across New
 * York City (HQ), Los Angeles, and seasonal program sites
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `beam`
 * — **first-cohort slug-acronym-expansion D-09 asymmetry**
 * vs the wire `company_name === 'Bridge to Enter Advanced
 * Mathematics (BEAM)'` — slug 4 bytes (the acronym only) vs
 * wire 43 bytes (full org name + acronym in parens).
 *
 * **One structural deviation from the Branch (Spec 121)
 * template** — D-09 sub-axis: BEAM's slug-acronym-expansion
 * asymmetry is a NEW first-cohort observation distinct from
 * prior internal-whitespace cases AND distinct from Oscar's
 * slug-extra-word asymmetry. **Second cohort observation of
 * slug-truncation D-09 sub-axis** (after Oscar Spec 133).
 *
 *   1. **D-09 — brand-name trim omitted with FIRST-COHORT
 *      slug-acronym-expansion asymmetric wire form.** Slug
 *      `beam` (4 bytes — the acronym only) vs wire `'Bridge
 *      to Enter Advanced Mathematics (BEAM)'` (43 bytes —
 *      full org name + acronym in parens). **Distinct from
 *      Oscar's slug-extra-word asymmetry** (Spec 133) —
 *      Oscar appended ONE word; BEAM fully expands the
 *      acronym. **Eighty-third cohort plugin to omit D-09**.
 *
 * Shared with Branch:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/beam/jobs/<id>`.
 *     **Fifty-first** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-second** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 14 wire
 *     titles in the run-346 probe carry trailing pad bytes;
 *     the plugin emits `listing.title` byte-for-byte without
 *     a `.trim()`. **Twenty-sixth cohort plugin to omit
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 14
 *     wire department names padded across 4 unique departments
 *     (`'HQ Central Programs'`, `'HQ Fundraising'`, `'Summer
 *     Programs'`, `'Yearround LA'`). **Seventy-fourth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/beam/jobs';

@SourcePlugin({
  site: Site.BEAM,
  name: 'BEAM',
  category: 'company',
})
@Injectable()
export class BeamService implements IScraper {
  private readonly logger = new Logger(BeamService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BEAM: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: emit wire title byte-for-byte (no trim).
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
        const id = `beam-${jobId}`;

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
            site: Site.BEAM,
            title,
            // D-09 omitted: first-cohort slug-acronym-expansion
            // asymmetric wire form — slug 'beam' (4b) vs wire
            // 'Bridge to Enter Advanced Mathematics (BEAM)'
            // (43b). Pass-through preserves byte-for-byte.
            companyName: listing.company_name ?? 'Bridge to Enter Advanced Mathematics (BEAM)',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/beam/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/14 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`BEAM: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BEAM scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
