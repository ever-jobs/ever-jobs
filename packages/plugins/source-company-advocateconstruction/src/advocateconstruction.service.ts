import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Advocate Construction — Residential and commercial roofing, siding, and gutter contractor operating across U.S. metro markets.
 *
 * Advocate Construction is a U.S. residential and commercial exterior
 * contractor specializing in roofing, siding, and gutter installation
 * and repair, with significant work tied to storm and
 * insurance-related restoration. It operates through local offices
 * across multiple metro markets in the Midwest and Sunbelt, including
 * Kansas City, Chicago, St. Louis, Milwaukee, Detroit, and others. Its
 * hiring spans field operations and quality functions, with
 * departments such as the Operations Success Team and Quality Control
 * supporting field coordination and on-site inspection of roofing
 * projects.
 *
 * Sector: Construction. HQ: Lenexa, Kansas, USA (Kansas City metro).
 *
 * Highlights:
 *   - Specializes in roofing, siding, and gutters for residential and
 *     commercial properties
 *   - Operates across multiple metro markets including Kansas City,
 *     Chicago, St. Louis, Milwaukee, and Detroit
 *   - Hiring spans field operations (Operations Success Team) and
 *     Quality Control functions
 *   - Sample roles include Construction Field Coordinator and Field
 *     Job Quality Inspector for residential roofing
 *   - Work includes storm-damage and insurance-related restoration
 *     projects
 *
 * Source profile (Spec 194):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/advocateconstruction/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Advocate Construction'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 26 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/advocateconstruction/jobs';

@SourcePlugin({
  site: Site.ADVOCATECONSTRUCTION,
  name: 'Advocate Construction',
  category: 'company',
})
@Injectable()
export class AdvocateconstructionService implements IScraper {
  private readonly logger = new Logger(AdvocateconstructionService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Advocate Construction: fetching ${url}`);

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
        const id = `advocateconstruction-${jobId}`;

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
            site: Site.ADVOCATECONSTRUCTION,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Advocate Construction',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/advocateconstruction/jobs/${listing.id}`,
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

      this.logger.log(`Advocate Construction: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Advocate Construction scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
