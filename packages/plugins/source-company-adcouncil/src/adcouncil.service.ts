import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * the Ad Council — U.S. nonprofit that develops and distributes public service advertising campaigns.
 *
 * The Ad Council is an American nonprofit organization, founded in
 * 1942 and headquartered in New York City, that produces and
 * distributes public service advertising campaigns on behalf of
 * nonprofits, NGOs, and U.S. government agencies. It coordinates
 * donated creative and media services to deliver public service
 * announcements across a wide network of outlets on issues such as
 * health, safety, and social welfare. Its hiring spans functions
 * including strategic partnerships and external engagement, insights
 * and analytics, and administrative operations.
 *
 * Sector: Nonprofit / Public Service Advertising. HQ: New York City, United States.
 *
 * Highlights:
 *   - Nonprofit organization incorporated in 1942 as The Advertising
 *     Council, Inc.
 *   - Produces and distributes public service announcements (PSAs) for
 *     nonprofit, NGO, and government sponsors
 *   - Headquartered in New York City
 *   - Hiring across functions including Strategic Partnerships &
 *     External Engagement and Insights & Analytics
 *   - Open roles observed in campaign analysis and administrative
 *     operations
 *
 * Source profile (Spec 189):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/adcouncil/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'the Ad Council'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/adcouncil/jobs';

@SourcePlugin({
  site: Site.ADCOUNCIL,
  name: 'the Ad Council',
  category: 'company',
})
@Injectable()
export class AdcouncilService implements IScraper {
  private readonly logger = new Logger(AdcouncilService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`the Ad Council: fetching ${url}`);

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
        const id = `adcouncil-${jobId}`;

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
            site: Site.ADCOUNCIL,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'the Ad Council',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/adcouncil/jobs/${listing.id}`,
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

      this.logger.log(`the Ad Council: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`the Ad Council scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
