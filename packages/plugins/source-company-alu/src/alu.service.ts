import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ALU — Pan-African university network focused on leadership and entrepreneurial education, with campuses in Rwanda and Mauritius..
 *
 * ALU is African Leadership University, a network of tertiary
 * institutions offering undergraduate and graduate programs with a
 * focus on leadership and entrepreneurship. Founded in 2015 by Fred
 * Swaniker, it operates residential campuses in Mauritius (originally
 * the African Leadership College) and in Kigali, Rwanda, alongside
 * remote and online offerings. Its academic structure includes units
 * such as the School of Entrepreneurial Leadership, and it uses a
 * learning-coach model rather than traditional lecturing.
 *
 * Sector: Higher Education. HQ: Kigali, Rwanda.
 *
 * Highlights:
 *   - Operates campuses in Rwanda (ALU RW) and Mauritius, plus remote
 *     roles
 *   - Academic units include the School of Entrepreneurial Leadership
 *   - Uses a learning-coach model, hiring roles like Learning Coach
 *     and faculty-pool positions
 *   - Founded in 2015 by Fred Swaniker
 *
 * Source profile (Spec 251):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alu/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'ALU'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 32 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alu/jobs';

@SourcePlugin({
  site: Site.ALU,
  name: 'ALU',
  category: 'company',
})
@Injectable()
export class AluService implements IScraper {
  private readonly logger = new Logger(AluService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ALU: fetching ${url}`);

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
        const id = `alu-${jobId}`;

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
            site: Site.ALU,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'ALU',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alu/jobs/${listing.id}`,
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

      this.logger.log(`ALU: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ALU scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
