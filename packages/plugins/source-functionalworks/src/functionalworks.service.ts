import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  FUNCTIONALWORKS_API_URL,
  FUNCTIONALWORKS_DEFAULT_RESULTS,
  FUNCTIONALWORKS_HEADERS,
  FUNCTIONALWORKS_QUERY,
} from './functionalworks.constants';
import { FunctionalworksJob, FunctionalworksGraphQLResponse } from './functionalworks.types';

@SourcePlugin({
  site: Site.FUNCTIONALWORKS,
  name: 'FunctionalWorks',
  category: 'niche',
})
@Injectable()
export class FunctionalworksService implements IScraper {
  private readonly logger = new Logger(FunctionalworksService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? FUNCTIONALWORKS_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FUNCTIONALWORKS_HEADERS);

    this.logger.log(
      `Fetching Functional Works GraphQL API (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.post(FUNCTIONALWORKS_API_URL, {
        query: FUNCTIONALWORKS_QUERY,
      });
      const body: FunctionalworksGraphQLResponse = response.data;

      if (!body || !body.data || !Array.isArray(body.data.jobs)) {
        this.logger.warn('Functional Works returned empty or invalid response');
        return new JobResponseDto([]);
      }

      const rawJobs = body.data.jobs;
      this.logger.log(`Functional Works returned ${rawJobs.length} postings`);

      const jobs: JobPostDto[] = [];

      for (const posting of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(posting, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(posting);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Functional Works posting ${posting.slug}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Functional Works returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Functional Works scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Check whether a posting matches the given search term.
   */
  private matchesSearch(posting: FunctionalworksJob, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (posting.title ?? '').toLowerCase();
    const company = (posting.company?.name ?? '').toLowerCase();
    const tags = (posting.tags ?? []).map((t) => (t.label ?? '').toLowerCase()).join(' ');

    return title.includes(term) || company.includes(term) || tags.includes(term);
  }

  /**
   * Map a Functional Works job to a JobPostDto.
   */
  private mapJob(posting: FunctionalworksJob): JobPostDto | null {
    if (!posting.title || !posting.slug) return null;

    const jobUrl = `https://functional.works-hub.com/jobs/${posting.slug}`;

    // Build location from location object
    const location = this.parseLocation(posting);

    // Build compensation from remuneration object
    const compensation = this.parseCompensation(posting);

    // Parse date
    let datePosted: string | undefined;
    if (posting.firstPublished) {
      try {
        datePosted = toDateOnly(posting.firstPublished) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Build description from tags
    const description = this.buildDescription(posting);

    // Remote status
    const isRemote = posting.remote ?? false;

    return new JobPostDto({
      id: `functionalworks-${posting.slug}`,
      title: posting.title,
      companyName: posting.company?.name ?? null,
      jobUrl,
      location,
      description,
      compensation: compensation ?? undefined,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.FUNCTIONALWORKS,
    });
  }

  /**
   * Parse location from the posting location object.
   */
  private parseLocation(posting: FunctionalworksJob): LocationDto {
    const loc = posting.location;
    if (!loc) {
      return new LocationDto({});
    }

    return new LocationDto({
      city: loc.city ?? null,
      country: loc.country ?? null,
    });
  }

  /**
   * Parse remuneration into a CompensationDto.
   */
  private parseCompensation(posting: FunctionalworksJob): CompensationDto | null {
    const rem = posting.remuneration;
    if (!rem || rem.competitive || (!rem.min && !rem.max)) return null;

    // Map timePeriod to CompensationInterval
    let interval = CompensationInterval.YEARLY;
    if (rem.timePeriod) {
      const tp = rem.timePeriod.toLowerCase();
      if (tp.includes('month')) {
        interval = CompensationInterval.MONTHLY;
      } else if (tp.includes('day') || tp.includes('daily')) {
        interval = CompensationInterval.DAILY;
      } else if (tp.includes('hour')) {
        interval = CompensationInterval.HOURLY;
      }
    }

    return new CompensationDto({
      interval,
      minAmount: rem.min ?? null,
      maxAmount: rem.max ?? null,
      currency: rem.currency ?? 'GBP',
    });
  }

  /**
   * Build a description string from tags and descriptionHtml.
   */
  private buildDescription(posting: FunctionalworksJob): string | undefined {
    const parts: string[] = [];

    if (posting.tags && posting.tags.length > 0) {
      const labels = posting.tags
        .map((t) => t.label)
        .filter(Boolean)
        .join(', ');
      if (labels) {
        parts.push(`Tags: ${labels}`);
      }
    }

    if (posting.descriptionHtml) {
      // Strip HTML tags for plain text description
      const plain = posting.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain) {
        parts.push(plain);
      }
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
