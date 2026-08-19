import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Antenna — Subscription analytics and market intelligence for the U.S. media and entertainment economy..
 *
 * Antenna is a data and analytics provider focused on the U.S.
 * subscription economy, offering standardized metrics, competitive
 * benchmarks, and market intelligence on subscriber behavior across
 * media and entertainment services. The company helps brands
 * understand subscriber acquisition, retention, and engagement using a
 * proprietary, AI-powered approach. It operates remote-first and hires
 * across the United States, with some roles based in Bogotá, Colombia.
 *
 * Sector: Data & Analytics (Subscription Intelligence). HQ: New York, United States.
 *
 * Highlights:
 *   - Provides standardized subscription metrics and competitive
 *     benchmarks for media and entertainment brands
 *   - Remote-first company hiring across the United States, plus a
 *     presence in Bogotá, Colombia
 *   - Hiring spans Analytics, Engineering, Customer Success, and Sales
 *     & Account Management functions
 *   - Uses a proprietary AI-powered approach to analyze subscriber
 *     acquisition, retention, and engagement
 *
 * Source profile (Spec 272):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/antenna/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Antenna'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/antenna/jobs';

@SourcePlugin({
  site: Site.ANTENNA,
  name: 'Antenna',
  category: 'company',
})
@Injectable()
export class AntennaService implements IScraper {
  private readonly logger = new Logger(AntennaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Antenna: fetching ${url}`);

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
        const id = `antenna-${jobId}`;

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
            site: Site.ANTENNA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Antenna',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/antenna/jobs/${listing.id}`,
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

      this.logger.log(`Antenna: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Antenna scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
