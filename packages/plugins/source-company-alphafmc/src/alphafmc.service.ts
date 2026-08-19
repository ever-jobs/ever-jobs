import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alpha FMC - UK  — Specialist management and technology consultancy for the financial services industry..
 *
 * Alpha FMC is a global management and technology consultancy focused
 * exclusively on the financial services sector, including asset and
 * wealth management, insurance, and alternative investments. Its
 * services span operating-model design, enterprise performance
 * management, and technology implementation, and it incorporates
 * Lionpoint (later rebranded Alpha Alternatives), which provides
 * strategy, technology, and operations consulting to the alternative
 * investment industry. Open roles span Enterprise Performance
 * Management, Enterprise Technology, and Limited Partner Services,
 * including specialist consultants for planning platforms such as
 * Anaplan and Pigment.
 *
 * Sector: Financial services consulting. HQ: London, United Kingdom.
 *
 * Highlights:
 *   - Sector-focused consultancy serving asset management, wealth
 *     management, insurance, and alternative investments
 *   - Enterprise Performance Management practice with specialists in
 *     Anaplan and Pigment
 *   - Enterprise Technology and Limited Partner Services (LPS)
 *     practices, including the Lionpoint / Alpha Alternatives business
 *   - Hiring across the United Kingdom, from senior consultants to
 *     internal IT support
 *
 * Source profile (Spec 240):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alphafmc/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alpha FMC - UK '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alphafmc/jobs';

@SourcePlugin({
  site: Site.ALPHAFMC,
  name: 'Alpha FMC - UK ',
  category: 'company',
})
@Injectable()
export class AlphafmcService implements IScraper {
  private readonly logger = new Logger(AlphafmcService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alpha FMC - UK : fetching ${url}`);

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
        const id = `alphafmc-${jobId}`;

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
            site: Site.ALPHAFMC,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alpha FMC - UK ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alphafmc/jobs/${listing.id}`,
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

      this.logger.log(`Alpha FMC - UK : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alpha FMC - UK  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
