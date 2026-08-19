import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Figure Lending — Blockchain-powered home-equity lending platform and one of the largest non-bank HELOC originators in the United States.
 *
 * Figure Lending operates a technology platform for home equity lines
 * of credit (HELOCs), using blockchain infrastructure to streamline
 * origination, underwriting, and settlement. Founded in 2018, the
 * company offers a fully digital application process that can deliver
 * approvals in minutes and funding within days. Its software has been
 * used to originate billions of dollars in home equity, making it one
 * of the largest non-bank HELOC providers in the country. The platform
 * also extends into a broader marketplace for buying, selling, and
 * financing loan assets.
 *
 * Sector: Fintech / Lending. HQ: San Francisco, California, USA.
 *
 * Highlights:
 *   - Founded in 2018
 *   - One of the largest non-bank HELOC providers in the U.S.
 *   - Blockchain-based origination and settlement platform
 *   - Billions of dollars in home equity originated
 *   - Fully digital application with approvals in minutes
 *
 * Source profile (Spec 743):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/figure/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Figure Lending'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 22 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/figure/jobs';

@SourcePlugin({
  site: Site.FIGURE_LENDING,
  name: 'Figure Lending',
  category: 'company',
})
@Injectable()
export class FigureLendingService implements IScraper {
  private readonly logger = new Logger(FigureLendingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Figure Lending: fetching ${url}`);

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
        const id = `figure-${jobId}`;

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
            site: Site.FIGURE_LENDING,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Figure Lending',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/figure/jobs/${listing.id}`,
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

      this.logger.log(`Figure Lending: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Figure Lending scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
