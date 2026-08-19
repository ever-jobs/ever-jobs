import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { NAVJOBS_FEED_URL, NAVJOBS_PUBLIC_TOKEN_URL, NAVJOBS_HEADERS, NAVJOBS_DEFAULT_RESULTS } from './navjobs.constants';
import { NavJobsFeedResponse, NavJobsFeedItem } from './navjobs.types';

@SourcePlugin({
  site: Site.NAVJOBS,
  name: 'NavJobs',
  category: 'government',
})
@Injectable()
export class NavJobsService implements IScraper {
  private readonly logger = new Logger(NavJobsService.name);
  private readonly configuredToken: string | null;
  private cachedPublicToken: string | null = null;

  constructor() {
    this.configuredToken = process.env.NAVJOBS_TOKEN ?? null;
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? NAVJOBS_DEFAULT_RESULTS;

    const token = this.configuredToken ?? await this.fetchPublicToken();
    if (!token) {
      this.logger.error('Failed to obtain NAV Jobs token');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...NAVJOBS_HEADERS,
      Authorization: `Bearer ${token}`,
    });

    this.logger.log(`Fetching NAV Jobs feed (resultsWanted=${resultsWanted})`);

    try {
      const response = await client.get(NAVJOBS_FEED_URL);
      const data = response.data as NavJobsFeedResponse;

      const items = data?.items ?? [];
      if (items.length === 0) {
        this.logger.log('No NAV Jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(`NAV Jobs feed returned ${items.length} items`);

      const jobs: JobPostDto[] = [];

      for (const item of items) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(item, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(item, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping NAV job ${item.id}: ${err.message}`);
        }
      }

      this.logger.log(`NAV Jobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`NAV Jobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private async fetchPublicToken(): Promise<string | null> {
    if (this.cachedPublicToken) return this.cachedPublicToken;

    try {
      const client = createHttpClient({ timeout: 10000 });
      const response = await client.get(NAVJOBS_PUBLIC_TOKEN_URL);
      this.cachedPublicToken = response.data as string;
      this.logger.log('NAV Jobs public token obtained');
      return this.cachedPublicToken;
    } catch (err: any) {
      this.logger.error(`NAV Jobs public token error: ${err.message}`);
      return null;
    }
  }

  private matchesSearch(item: NavJobsFeedItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const business = (item._feed_entry?.businessName ?? '').toLowerCase();
    const description = (item._feed_entry?.description ?? '').toLowerCase();
    return title.includes(term) || business.includes(term) || description.includes(term);
  }

  private mapJob(item: NavJobsFeedItem, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!item.title || !item.url) return null;

    const entry = item._feed_entry;

    let description: string | null = entry?.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    const location = new LocationDto({
      city: entry?.municipal ?? null,
      state: entry?.county ?? null,
      country: 'Norway',
    });

    let datePosted: string | null = null;
    if (entry?.published) {
      try {
        datePosted = toDateOnly(entry.published);
      } catch {
        datePosted = null;
      }
    }

    const jobUrl = entry?.applicationUrl ?? entry?.sourceurl ?? item.url;

    return new JobPostDto({
      id: `navjobs-${entry?.uuid ?? item.id}`,
      title: item.title,
      companyName: entry?.businessName ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.NAVJOBS,
    });
  }
}
