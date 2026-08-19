import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * SES AI — SES AI develops and manufactures high-performance Li-Metal rechargeable batteries for electric vehicles, aviation, and other applications, using AI to accelerate battery R&D and manufacturing..
 *
 * SES AI Corp. (NYSE: SES) is a developer and manufacturer of
 * high-performance Lithium-Metal (Li-Metal) rechargeable batteries for
 * electric vehicles, urban air mobility, and other applications.
 * Founded in 2012 with roots at MIT, the company is headquartered in
 * Woburn, Massachusetts (Greater Boston) and operates facilities in
 * Shanghai, plus Singapore and Seoul. It positions itself as
 * integrating AI across battery R&D, materials discovery, cell design,
 * manufacturing, and battery health/safety monitoring. The board name
 * "SES" maps to the publicly traded brand SES AI.
 *
 * Sector: Battery Technology / EV Energy Storage (Li-Metal). HQ: Woburn, Massachusetts, USA.
 *
 * Highlights:
 *   - Publicly traded on the NYSE under ticker SES
 *   - Headquartered in Woburn, MA (Greater Boston) with operations in
 *     Shanghai, Singapore, and Seoul
 *   - Founded in 2012 with origins at MIT
 *   - Develops Li-Metal rechargeable batteries for EVs and electric
 *     aviation
 *   - Applies AI/ML across battery R&D, materials chemistry, and
 *     manufacturing
 *
 * Source profile (Spec 796):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/sesai/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'SES AI'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 43 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sesai/jobs';

@SourcePlugin({
  site: Site.SES_AI,
  name: 'SES AI',
  category: 'company',
})
@Injectable()
export class SESAIService implements IScraper {
  private readonly logger = new Logger(SESAIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`SES AI: fetching ${url}`);

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
        const id = `sesai-${jobId}`;

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
            site: Site.SES_AI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'SES AI',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sesai/jobs/${listing.id}`,
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

      this.logger.log(`SES AI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`SES AI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
