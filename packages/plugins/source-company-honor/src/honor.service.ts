import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Honor — home-care platform for older adults.
 *
 * Honor operates a technology and operations platform for non-medical
 * home care for older adults, and following its acquisition of Home
 * Instead runs one of the largest home-care networks in the world.
 *
 * Sector: Health-tech / Home care. HQ: San Francisco, CA, USA.
 *
 * Highlights:
 *   - Owns the Home Instead global home-care franchise network.
 *   - Care Platform matches caregivers with clients at scale.
 *
 * Source profile (Spec 497):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/honor/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Honor'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 18 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/honor/jobs';

@SourcePlugin({
  site: Site.HONOR,
  name: 'Honor',
  category: 'company',
})
@Injectable()
export class HonorService implements IScraper {
  private readonly logger = new Logger(HonorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Honor: fetching ${url}`);

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
        const id = `honor-${jobId}`;

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
            site: Site.HONOR,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Honor',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/honor/jobs/${listing.id}`,
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

      this.logger.log(`Honor: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Honor scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
