import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Newsela — K-12 instructional content platform delivering standards-aligned reading and learning materials across core subjects.
 *
 * Newsela is an educational technology company that builds an
 * instructional content platform for K-12 classrooms. It adapts
 * thousands of standards-aligned articles, texts, videos, and
 * activities across English language arts, social studies, science,
 * and STEM, leveling content to meet students at different reading
 * abilities. The platform also provides teacher dashboards,
 * assessments, and writing-feedback tools to support classroom
 * instruction. It is widely used across U.S. schools by millions of
 * teachers and students.
 *
 * Sector: EdTech / K-12 Instructional Content. HQ: New York, NY, USA.
 *
 * Highlights:
 *   - Headquartered in New York City
 *   - K-12 platform spanning ELA, social studies, science, and STEM
 *   - Library of thousands of standards-aligned, reading-leveled texts
 *     and activities
 *   - Adopted across a large majority of U.S. school districts
 *   - Reached unicorn ($1B) valuation with $170M+ raised
 *
 * Source profile (Spec 751):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/newsela/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Newsela'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 16 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/newsela/jobs';

@SourcePlugin({
  site: Site.NEWSELA,
  name: 'Newsela',
  category: 'company',
})
@Injectable()
export class NewselaService implements IScraper {
  private readonly logger = new Logger(NewselaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Newsela: fetching ${url}`);

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
        const id = `newsela-${jobId}`;

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
            site: Site.NEWSELA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Newsela',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/newsela/jobs/${listing.id}`,
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

      this.logger.log(`Newsela: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Newsela scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
