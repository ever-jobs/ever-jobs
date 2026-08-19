import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ALTEN Technology USA — US engineering and technology consultancy serving aerospace, automotive, robotics, and life sciences clients..
 *
 * ALTEN Technology USA is the United States arm of ALTEN, a
 * France-based engineering and technology consulting group that
 * provides outsourced product development and engineering services to
 * clients in regulated, hardware-intensive industries. Its US hiring
 * spans aerospace, automotive, robotics and automation, and life
 * sciences, with technical roles such as aircraft exterior lighting
 * engineers alongside business development and sales positions. The
 * company staffs project teams across multiple US engineering hubs,
 * including locations in Colorado, North Carolina, Michigan, Vermont,
 * and California.
 *
 * Sector: Engineering and technology consulting. HQ: Westminster, CO, United States (US operations); ALTEN group based in France.
 *
 * Highlights:
 *   - US entity of ALTEN, a France-based engineering services group
 *   - Hires across aerospace, automotive, robotics/automation, and
 *     life sciences
 *   - Technical roles include aircraft exterior lighting and product
 *     engineering
 *   - Multi-site US footprint: Colorado, North Carolina, Michigan,
 *     Vermont, California
 *   - Combines engineering delivery with business development/sales
 *     functions
 *
 * Source profile (Spec 247):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/altentechnologyusa/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'ALTEN Technology USA'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 139 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/altentechnologyusa/jobs';

@SourcePlugin({
  site: Site.ALTENTECHNOLOGYUSA,
  name: 'ALTEN Technology USA',
  category: 'company',
})
@Injectable()
export class AltentechnologyusaService implements IScraper {
  private readonly logger = new Logger(AltentechnologyusaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ALTEN Technology USA: fetching ${url}`);

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
        const id = `altentechnologyusa-${jobId}`;

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
            site: Site.ALTENTECHNOLOGYUSA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'ALTEN Technology USA',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/altentechnologyusa/jobs/${listing.id}`,
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

      this.logger.log(`ALTEN Technology USA: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ALTEN Technology USA scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
