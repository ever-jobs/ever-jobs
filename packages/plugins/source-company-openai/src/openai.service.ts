import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

/** OpenAI uses Ashby for their careers page */
const API_URL = 'https://api.ashbyhq.com/posting-api/job-board/openai';

@SourcePlugin({
  site: Site.OPENAI,
  name: 'OpenAI',
  category: 'company',
})
@Injectable()
export class OpenAIService implements IScraper {
  private readonly logger = new Logger(OpenAIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      this.logger.log(`OpenAI: fetching ${API_URL}`);

      const { data } = await client.get<any>(API_URL);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.title ?? '';
        if (!title) continue;

        // Filter by search term if provided
        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          if (!title.toLowerCase().includes(term) &&
              !(listing.departmentName ?? '').toLowerCase().includes(term)) {
            continue;
          }
        }

        const jobId = listing.id ?? '';
        const id = `openai-${jobId}`;

        const locationStr = listing.locationName ?? listing.location ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        // Filter by location if provided
        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.OPENAI,
            title,
            companyName: 'OpenAI',
            jobUrl: listing.jobUrl ?? `https://openai.com/careers/${listing.id}`,
            location,
            description: listing.descriptionHtml
              ? stripHtmlTags(listing.descriptionHtml)
              : listing.descriptionPlain ?? null,
            datePosted: listing.publishedAt ?? null,
            isRemote: listing.isRemote ?? (locationStr?.toLowerCase().includes('remote') ?? false),
            department: listing.departmentName ?? listing.team ?? null,
          }),
        );
      }

      this.logger.log(`OpenAI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`OpenAI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
