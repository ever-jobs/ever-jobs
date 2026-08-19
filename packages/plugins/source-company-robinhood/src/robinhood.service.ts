import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

/**
 * Robinhood publishes its careers board through Greenhouse. The slug
 * is `robinhoodjobs` (not the bare `robinhood`, which is registered
 * to an unrelated tenant). See Spec 026 § 10 D-05.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/robinhoodjobs/jobs';

@SourcePlugin({
  site: Site.ROBINHOOD,
  name: 'Robinhood',
  category: 'company',
})
@Injectable()
export class RobinhoodService implements IScraper {
  private readonly logger = new Logger(RobinhoodService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Robinhood: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.title ?? '';
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
        const id = `robinhood-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.ROBINHOOD,
            title,
            companyName: 'Robinhood',
            jobUrl:
              listing.absolute_url ??
              `https://careers.robinhood.com/jobs/${listing.id}`,
            location,
            description: listing.content ? stripHtmlTags(listing.content) : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Robinhood: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Robinhood scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
