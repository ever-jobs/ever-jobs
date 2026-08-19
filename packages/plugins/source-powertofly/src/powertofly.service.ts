import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  POWERTOFLY_API_URL,
  POWERTOFLY_DEFAULT_RESULTS,
  POWERTOFLY_HEADERS,
} from './powertofly.constants';
import { PowertoflyItem, PowertoflyApiResponse } from './powertofly.types';

@SourcePlugin({
  site: Site.POWERTOFLY,
  name: 'PowerToFly',
  category: 'niche',
})
@Injectable()
export class PowertoflyService implements IScraper {
  private readonly logger = new Logger(PowertoflyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? POWERTOFLY_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(POWERTOFLY_HEADERS);

    this.logger.log(
      `Fetching PowerToFly API (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(POWERTOFLY_API_URL);
      const data: PowertoflyApiResponse = response.data;

      if (!data || !Array.isArray(data.items)) {
        this.logger.warn('PowerToFly returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`PowerToFly returned ${data.items.length} items`);

      const jobs: JobPostDto[] = [];

      for (const item of data.items) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(item, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(item);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping PowerToFly item ${item.guid}: ${err.message}`,
          );
        }
      }

      this.logger.log(`PowerToFly returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`PowerToFly scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Check whether an item matches the given search term.
   */
  private matchesSearch(item: PowertoflyItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const location = (item.job_location ?? '').toLowerCase();
    const categories = (item.categories ?? []).join(' ').toLowerCase();

    return (
      title.includes(term) ||
      description.includes(term) ||
      location.includes(term) ||
      categories.includes(term)
    );
  }

  /**
   * Map a PowerToFly item to a JobPostDto.
   */
  private mapJob(item: PowertoflyItem): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Build location from job_location
    const location = this.parseLocation(item);

    // Parse date
    let datePosted: string | undefined;
    if (item.published_on) {
      try {
        datePosted = toDateOnly(item.published_on) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Remote status from type field
    const isRemote = (item.type ?? '').toLowerCase() === 'remote';

    // description field contains company name on PowerToFly
    const companyName = item.description ?? null;

    // Build description from categories
    const description = this.buildDescription(item);

    // Generate ID from GUID or URL
    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    return new JobPostDto({
      id: `powertofly-${jobId}`,
      title: item.title,
      companyName,
      jobUrl: item.link,
      location,
      description,
      compensation: undefined,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.POWERTOFLY,
    });
  }

  /**
   * Parse location from the item job_location field.
   */
  private parseLocation(item: PowertoflyItem): LocationDto {
    if (!item.job_location) {
      return new LocationDto({});
    }

    // job_location may be "City, Country" or just "Remote"
    const parts = item.job_location.split(',').map((p) => p.trim());

    return new LocationDto({
      city: parts[0] ?? null,
      country: parts.length > 1 ? parts[parts.length - 1] : null,
    });
  }

  /**
   * Build a description from categories and type.
   */
  private buildDescription(item: PowertoflyItem): string | undefined {
    const parts: string[] = [];

    if (item.categories && item.categories.length > 0) {
      parts.push(`Department: ${item.categories[0]}`);
      if (item.categories.length > 1) {
        parts.push(`Categories: ${item.categories.join(', ')}`);
      }
    }

    if (item.type) {
      parts.push(`Type: ${item.type}`);
    }

    if (item.job_location) {
      parts.push(`Location: ${item.job_location}`);
    }

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /**
   * Extract a short ID from a URL by using the last path segment.
   */
  private extractIdFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] ?? this.hashString(url);
    } catch {
      return this.hashString(url);
    }
  }

  /**
   * Simple string hash for fallback IDs.
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
