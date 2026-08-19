import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alpha Financial Markets Consulting — Specialist consultancy serving asset and wealth management, insurance, and financial services firms..
 *
 * Alpha Financial Markets Consulting (Alpha FMC) is a management
 * consultancy specializing in the asset and wealth management,
 * insurance, and broader financial services sectors. The firm advises
 * clients on operating model design, regulatory compliance and risk,
 * technology implementation, and transformation across front, middle,
 * and back office functions. It operates internationally, with hiring
 * across the UK, North America, the Middle East, and Asia-Pacific.
 *
 * Sector: Management consulting (financial services). HQ: London, United Kingdom.
 *
 * Highlights:
 *   - Focused on asset & wealth management, insurance, and wider
 *     financial services clients
 *   - Service lines span enterprise performance management, regulatory
 *     compliance & risk, and front/middle office
 *   - Roles include technology-platform specialists such as
 *     Workiva-focused analysts
 *   - International footprint: London, Toronto, United States,
 *     Singapore, Qatar (Doha), and Saudi Arabia (Riyadh)
 *
 * Source profile (Spec 241):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alphafmcroles/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alpha Financial Markets Consulting'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 92 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alphafmcroles/jobs';

@SourcePlugin({
  site: Site.ALPHAFMCROLES,
  name: 'Alpha Financial Markets Consulting',
  category: 'company',
})
@Injectable()
export class AlphafmcrolesService implements IScraper {
  private readonly logger = new Logger(AlphafmcrolesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alpha Financial Markets Consulting: fetching ${url}`);

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
        const id = `alphafmcroles-${jobId}`;

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
            site: Site.ALPHAFMCROLES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alpha Financial Markets Consulting',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alphafmcroles/jobs/${listing.id}`,
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

      this.logger.log(`Alpha Financial Markets Consulting: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alpha Financial Markets Consulting scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
