import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Anteriad  — B2B marketing and data solutions provider for intent data, demand generation, and account-based marketing..
 *
 * Anteriad is a B2B marketing and data solutions provider offering
 * intent data, demand generation, account-based marketing, and
 * analytics to enterprise marketing teams. The company was formed by
 * combining MeritB2B and True Influence (along with 180byTwo, and
 * later BNZSA) and operates internationally across the US, EMEA, and
 * APAC. Its hiring spans database and programmatic operations, client
 * partnerships, data engineering, and customer success.
 *
 * Sector: B2B Marketing & Data Solutions. HQ: Rye Brook, New York, United States.
 *
 * Highlights:
 *   - Offers B2B intent data, demand generation, ABM, and analytics
 *     solutions
 *   - Formed from MeritB2B and True Influence, later adding BNZSA
 *   - Global footprint across the US, EMEA, and APAC, including an
 *     India office in Bangalore
 *   - Departments include Database Solutions, Programmatic, and
 *     Digital Revenue Operations
 *   - Hires remote roles across the US and UK plus client-facing and
 *     data engineering positions
 *
 * Source profile (Spec 273):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/anteriad/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Anteriad '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 8 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/anteriad/jobs';

@SourcePlugin({
  site: Site.ANTERIAD,
  name: 'Anteriad ',
  category: 'company',
})
@Injectable()
export class AnteriadService implements IScraper {
  private readonly logger = new Logger(AnteriadService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Anteriad : fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
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
        const id = `anteriad-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.ANTERIAD,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Anteriad ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/anteriad/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`Anteriad : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Anteriad  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
