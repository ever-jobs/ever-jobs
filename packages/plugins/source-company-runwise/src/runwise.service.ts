import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Runwise — Runwise is an energy-tech company that uses smart hardware and software to control and optimize building heating systems, cutting energy use, costs, and carbon emissions..
 *
 * Runwise is a New York City-based climate/energy-tech startup (also
 * with a Boston presence) that retrofits and controls building heating
 * systems across thousands of buildings, primarily in the Northeast
 * US. Its proprietary hardware and software service measures
 * conditions and intelligently controls boilers and heating equipment,
 * significantly reducing energy usage and lowering costs and carbon
 * output. Its customers range from large property owners to individual
 * co-ops and condos. The sample sales and customer-success roles in
 * New York are consistent with Runwise's go-to-market team serving
 * NYC-area property companies.
 *
 * Sector: Climate Tech / Smart Building Energy Management. HQ: New York, New York, USA.
 *
 * Highlights:
 *   - Controls heating systems in roughly 2,000+ buildings,
 *     concentrated in the Northeast US
 *   - Combines proprietary hardware (controllers/sensors) with
 *     software to optimize building heat
 *   - Mission: make cities more affordable, sustainable, and healthier
 *     by cutting heating energy use and carbon
 *   - Headquartered in New York City with a presence in Boston
 *   - Serves property owners, managers, and residential co-ops/condos
 *
 * Source profile (Spec 795):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/runwise/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Runwise'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/runwise/jobs';

@SourcePlugin({
  site: Site.RUNWISE,
  name: 'Runwise',
  category: 'company',
})
@Injectable()
export class RunwiseService implements IScraper {
  private readonly logger = new Logger(RunwiseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Runwise: fetching ${url}`);

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
        const id = `runwise-${jobId}`;

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
            site: Site.RUNWISE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Runwise',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/runwise/jobs/${listing.id}`,
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

      this.logger.log(`Runwise: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Runwise scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
