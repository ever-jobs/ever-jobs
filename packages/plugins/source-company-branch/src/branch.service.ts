import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Branch Metrics, Inc. (Branch.io) — operator of the
 * **dominant mobile deep-linking + cross-platform attribution
 * platform pioneered around the universal-deferred-deep-link-
 * as-a-service data model** (founded by Alex Austin, Mike
 * Molinet, Mada Seghete, and Dmitri Gaskin in 2014 in Palo
 * Alto, California; raised ~$130M across rounds at peak ~$4B
 * valuation in February 2022 led by Founders Fund; ships
 * Branch Universal Links + Universal Email + Universal Ads,
 * Branch Attribution, Mobile Linking Platform (MLP), Journeys
 * (in-app banners), Quick Links, and Predictive Modeling +
 * SafeTrack across the mobile-deep-linking / cross-platform-
 * attribution / mobile-marketing-analytics segment —
 * alongside competitors AppsFlyer, Adjust, Kochava, Singular,
 * and Apple's own SKAdNetwork — with a hybrid distributed
 * workforce concentrated across Palo Alto (HQ), San Francisco,
 * and Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `branch` (case-symmetric with the wire `company_name
 * === 'Branch'`; see Spec 121 § 10 D-05).
 *
 * **Zero structural deviations from the Pendo (Spec 118)
 * template** — making this the **twenty-fourth** Greenhouse-
 * only company-direct plugin in run-history to ship as a clean
 * re-spin. All five primary axes share with Pendo:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/branch/jobs/<id>`.
 *     **Fortieth** plugin in the cohort to use variant 2 —
 *     the cohort crosses the 40-plugin variant-2 threshold
 *     at this run.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Branch'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `branch`). **Sixty-eighth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 11 wire
 *     titles in the run-331 probe carry trailing pad bytes;
 *     the plugin emits `listing.title` byte-for-byte without
 *     a `.trim()`. **Twenty-third cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 11
 *     wire department names padded across 7 unique departments
 *     (`'Customer Integration'`, `'Engineering'`, `'Finance'`,
 *     `'Marketing'`, `'Sales'`, `'Security'`, `'Support
 *     Operations'` — clean multi-token forms with internal
 *     whitespace). **Sixty-first cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/branch/jobs';

@SourcePlugin({
  site: Site.BRANCH,
  name: 'Branch',
  category: 'company',
})
@Injectable()
export class BranchService implements IScraper {
  private readonly logger = new Logger(BranchService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Branch: fetching ${url}`);

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
        const id = `branch-${jobId}`;

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
            site: Site.BRANCH,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Branch',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/branch/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/11 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Branch: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Branch scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
