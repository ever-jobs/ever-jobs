import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

/** Google Careers API endpoint */
const API_URL = 'https://careers.google.com/api/v3/search/';
const CAREERS_BASE = 'https://careers.google.com/jobs/results/';

@SourcePlugin({
  site: Site.GOOGLE_CAREERS,
  name: 'Google Careers',
  category: 'company',
})
@Injectable()
export class GoogleCareersService implements IScraper {
  private readonly logger = new Logger(GoogleCareersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const params = new URLSearchParams();
      if (input.searchTerm) params.set('q', input.searchTerm);
      if (input.location) params.set('location', input.location);
      params.set('page_size', String(Math.min(resultsWanted, 100)));

      const url = `${API_URL}?${params.toString()}`;
      this.logger.log(`Google Careers: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? data?.results ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.title ?? listing.job_title ?? '';
        if (!title) continue;

        const jobId = listing.id ?? listing.job_id ?? '';
        const id = `google-careers-${jobId || Math.abs(this.hashCode(title))}`;

        const locationStr = listing.locations?.join(', ')
          ?? listing.location ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        const description = listing.description
          ? stripHtmlTags(listing.description)
          : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.GOOGLE_CAREERS,
            title,
            companyName: 'Google',
            jobUrl: listing.apply_url ?? `${CAREERS_BASE}${jobId}`,
            location,
            description,
            datePosted: listing.publish_date ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
          }),
        );
      }

      this.logger.log(`Google Careers: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Google Careers scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
