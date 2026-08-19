import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Garner Health — Healthcare data and benefits company that helps employees find top-quality doctors and offsets their out-of-pocket costs..
 *
 * Garner Health is a healthcare technology company that uses a large
 * database of physician claims data to identify high-quality,
 * cost-effective doctors for employees of its client organizations. It
 * pairs this doctor-recommendation engine with a financial incentive
 * program, typically a health reimbursement arrangement, that helps
 * members offset out-of-pocket medical costs when they see recommended
 * providers. Garner sells primarily to self-insured employers and
 * benefits consultants as a complement to existing health plans. The
 * company operates a largely remote workforce and serves clients
 * across the United States.
 *
 * Sector: Health Tech / Employee Benefits. HQ: New York, New York, USA.
 *
 * Highlights:
 *   - Analyzes physician claims data to rank doctor quality and
 *     cost-effectiveness
 *   - Pairs doctor recommendations with a health reimbursement
 *     arrangement to lower member out-of-pocket spend
 *   - Sells to self-insured employers and benefits consultants as a
 *     health-plan complement
 *   - Operates a remote-first workforce serving clients nationwide
 *   - Headquartered in New York City
 *
 * Source profile (Spec 780):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/garnerhealth/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Garner Health'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 49 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/garnerhealth/jobs';

@SourcePlugin({
  site: Site.GARNER_HEALTH,
  name: 'Garner Health',
  category: 'company',
})
@Injectable()
export class GarnerHealthService implements IScraper {
  private readonly logger = new Logger(GarnerHealthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Garner Health: fetching ${url}`);

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
        const id = `garnerhealth-${jobId}`;

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
            site: Site.GARNER_HEALTH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Garner Health',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/garnerhealth/jobs/${listing.id}`,
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

      this.logger.log(`Garner Health: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Garner Health scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
