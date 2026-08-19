import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * American Institute — Career and vocational school with campuses across NJ, CT, and NY offering allied health and skilled trades programs..
 *
 * American Institute is a career and vocational school that operates
 * campuses in the U.S. Northeast, with locations across New Jersey
 * (Cherry Hill, Clifton, Somerset, Toms River), Connecticut (West
 * Hartford), and New York (White Plains). Its programs span allied
 * health and skilled trades fields, reflected in hiring for roles such
 * as Dental Assistant Instructor and Electrical Trades Instructor.
 * Hiring departments cover admissions, faculty, education management,
 * and student finance, indicating a typical for-profit/career-college
 * operating structure.
 *
 * Sector: Education / Vocational Training. HQ: Unknown.
 *
 * Highlights:
 *   - Operates multiple Northeast campuses (NJ, CT, NY) including
 *     Cherry Hill, Clifton, Somerset, Toms River, West Hartford, and
 *     White Plains
 *   - Offers allied health and skilled trades training, with roles
 *     like Dental Assistant Instructor and Electrical Trades
 *     Instructor
 *   - Hiring spans admissions, faculty, education management, and
 *     student finance functions
 *   - Recruits both instructional staff and student-facing admissions
 *     and finance roles
 *
 * Source profile (Spec 261):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/americaninstitute/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'American Institute'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 17 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/americaninstitute/jobs';

@SourcePlugin({
  site: Site.AMERICANINSTITUTE,
  name: 'American Institute',
  category: 'company',
})
@Injectable()
export class AmericaninstituteService implements IScraper {
  private readonly logger = new Logger(AmericaninstituteService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`American Institute: fetching ${url}`);

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
        const id = `americaninstitute-${jobId}`;

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
            site: Site.AMERICANINSTITUTE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'American Institute',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/americaninstitute/jobs/${listing.id}`,
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

      this.logger.log(`American Institute: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`American Institute scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
