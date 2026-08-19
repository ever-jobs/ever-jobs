import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Anaplan — Cloud-based connected planning platform for finance, sales, supply chain, and operations..
 *
 * Anaplan is an enterprise software company that provides a
 * cloud-based connected planning platform used for financial planning
 * and analysis, supply chain, sales, and operational planning. Its
 * technology centers on a calculation engine that lets large
 * organizations model scenarios and align budgeting, forecasting, and
 * planning across departments. The company sells primarily to
 * enterprise customers and was acquired by private equity firm Thoma
 * Bravo in 2022, taking it private after its earlier period as a
 * publicly traded company.
 *
 * Sector: Enterprise Software (Planning & Analytics). HQ: San Francisco, United States.
 *
 * Highlights:
 *   - Connected planning platform spanning finance, sales, supply
 *     chain, and operations
 *   - Dedicated Office of the CFO sales motion targeting finance
 *     leaders
 *   - Global footprint with roles across the US, France, and India
 *   - Hiring across Field Sales, Finance, GTM Operations, and Product
 *     & Engineering
 *   - Taken private by Thoma Bravo in 2022
 *
 * Source profile (Spec 267):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/anaplan/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Anaplan'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 260 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/anaplan/jobs';

@SourcePlugin({
  site: Site.ANAPLAN,
  name: 'Anaplan',
  category: 'company',
})
@Injectable()
export class AnaplanService implements IScraper {
  private readonly logger = new Logger(AnaplanService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Anaplan: fetching ${url}`);

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
        const id = `anaplan-${jobId}`;

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
            site: Site.ANAPLAN,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Anaplan',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/anaplan/jobs/${listing.id}`,
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

      this.logger.log(`Anaplan: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Anaplan scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
