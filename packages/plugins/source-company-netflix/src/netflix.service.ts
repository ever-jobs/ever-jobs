import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags } from '@ever-jobs/common';

const API_URL = 'https://jobs.netflix.com/api/search';
const CAREERS_BASE = 'https://jobs.netflix.com/jobs/';

@SourcePlugin({
  site: Site.NETFLIX,
  name: 'Netflix',
  category: 'company',
})
@Injectable()
export class NetflixService implements IScraper {
  private readonly logger = new Logger(NetflixService.name);

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
      params.set('page', '1');

      const url = `${API_URL}?${params.toString()}`;
      this.logger.log(`Netflix: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.records?.postings ?? data?.postings ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.text ?? listing.title ?? '';
        if (!title) continue;

        const jobId = listing.external_id ?? listing.id ?? '';
        const id = `netflix-${jobId || Math.abs(this.hashCode(title))}`;

        const locationStr = listing.location ?? listing.location_string ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.NETFLIX,
            title,
            companyName: 'Netflix',
            jobUrl: listing.url ?? `${CAREERS_BASE}${jobId}`,
            location,
            description: listing.description
              ? stripHtmlTags(listing.description)
              : null,
            datePosted: listing.created_at ?? listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: listing.team ?? listing.organization ?? null,
          }),
        );
      }

      this.logger.log(`Netflix: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Netflix scrape failed: ${err.message}`);
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
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}
