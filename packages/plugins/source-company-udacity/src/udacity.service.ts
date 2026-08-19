import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Udacity — Online learning platform offering project-based programs in AI, data science, and other in-demand tech skills.
 *
 * Udacity is an online education platform that delivers project-based
 * learning programs, called Nanodegrees, in fields such as artificial
 * intelligence, machine learning, data science, autonomous systems,
 * cloud computing, and programming. Its courses are developed with
 * industry input and combine real-world projects with mentor support
 * to build job-ready skills. Udacity serves both individual learners
 * and enterprise customers, providing workforce upskilling and
 * reskilling through its enterprise division. The company became part
 * of Accenture in 2024.
 *
 * Sector: EdTech / Online Learning. HQ: Mountain View, California, USA.
 *
 * Highlights:
 *   - Project-based Nanodegree programs in AI, data science, and cloud
 *     computing
 *   - Serves both individual learners and Fortune 1000 enterprise
 *     customers
 *   - Industry-built curricula with mentor support and hands-on
 *     projects
 *   - Acquired by Accenture in 2024
 *   - Headquartered in Mountain View, California
 *
 * Source profile (Spec 755):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/udacity/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Udacity'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 14 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/udacity/jobs';

@SourcePlugin({
  site: Site.UDACITY,
  name: 'Udacity',
  category: 'company',
})
@Injectable()
export class UdacityService implements IScraper {
  private readonly logger = new Logger(UdacityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Udacity: fetching ${url}`);

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
        const id = `udacity-${jobId}`;

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
            site: Site.UDACITY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Udacity',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/udacity/jobs/${listing.id}`,
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

      this.logger.log(`Udacity: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Udacity scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
