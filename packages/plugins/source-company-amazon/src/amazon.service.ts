import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import { stripHtmlTags } from '@ever-jobs/common';
import {
  AMAZON_API_URL, AMAZON_HEADERS, AMAZON_PAGE_SIZE, AMAZON_REQUEST_DELAY_MS,
} from './amazon.constants';
import { AmazonSearchResponse, AmazonSearchHit } from './amazon.types';

@SourcePlugin({
  site: Site.AMAZON,
  name: 'Amazon',
  category: 'company',
})
@Injectable()
export class AmazonService implements IScraper {
  private readonly logger = new Logger(AmazonService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const maxResults = input.resultsWanted ?? 100;
    let offset = 0;

    try {
      while (jobs.length < maxResults) {
        const response = await this.fetchPage(offset, input);
        if (!response?.searchHits?.length) break;

        for (const hit of response.searchHits) {
          if (jobs.length >= maxResults) break;
          const job = this.mapToJobPost(hit);
          if (job) jobs.push(job);
        }

        offset += AMAZON_PAGE_SIZE;
        if (response.searchHits.length < AMAZON_PAGE_SIZE) break;

        await this.delay(AMAZON_REQUEST_DELAY_MS);
      }

      this.logger.log(`Amazon: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Amazon scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private async fetchPage(
    offset: number,
    input: ScraperInputDto,
  ): Promise<AmazonSearchResponse | null> {
    const client = createHttpClient({
      proxies: input.proxies,
      timeout: input.requestTimeout ?? 30,
    });
    client.setHeaders(AMAZON_HEADERS);

    const payload = {
      searchType: 'JOB_SEARCH',
      start: offset,
      size: AMAZON_PAGE_SIZE,
      filters: [] as Record<string, unknown>[],
    };

    try {
      const { data } = await client.post<AmazonSearchResponse>(
        AMAZON_API_URL,
        payload,
      );
      return data;
    } catch (err: any) {
      if (err.response?.status === 400) return null;
      throw err;
    }
  }

  private mapToJobPost(hit: AmazonSearchHit): JobPostDto | null {
    const f = hit.fields;
    const first = (arr?: string[]) => arr?.[0] ?? null;

    const title = first(f.title);
    if (!title) return null;

    const descParts: string[] = [];
    const desc = first(f.description);
    if (desc) descParts.push(stripHtmlTags(desc));
    const basicQuals = first(f.basicQualifications);
    if (basicQuals) descParts.push(`\nBasic Qualifications:\n${stripHtmlTags(basicQuals)}`);
    const prefQuals = first(f.preferredQualifications);
    if (prefQuals) descParts.push(`\nPreferred Qualifications:\n${stripHtmlTags(prefQuals)}`);

    const locationStr = first(f.location);
    const locationParts = locationStr?.split(',').map((s) => s.trim()) ?? [];

    return new JobPostDto({
      id: first(f.urlNextStep) ?? undefined,
      site: Site.AMAZON,
      title,
      companyName: 'Amazon',
      jobUrl: first(f.urlNextStep) ?? undefined,
      location: new LocationDto({
        city: locationParts[0] ?? null,
        state: locationParts[1] ?? null,
        country: locationParts[2] ?? 'US',
      }),
      description: descParts.join('\n') || null,
      datePosted: first(f.createdDate) ?? undefined,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
