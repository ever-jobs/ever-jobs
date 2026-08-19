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
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  NOFLUFFJOBS_API_URL,
  NOFLUFFJOBS_DEFAULT_RESULTS,
  NOFLUFFJOBS_HEADERS,
} from './nofluffjobs.constants';
import { NoFluffJobsPosting } from './nofluffjobs.types';

@SourcePlugin({
  site: Site.NOFLUFFJOBS,
  name: 'NoFluffJobs',
  category: 'regional',
})
@Injectable()
export class NoFluffJobsService implements IScraper {
  private readonly logger = new Logger(NoFluffJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? NOFLUFFJOBS_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(NOFLUFFJOBS_HEADERS);

    this.logger.log(
      `Fetching NoFluffJobs API (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(NOFLUFFJOBS_API_URL);
      const data = response.data;

      if (!data || !Array.isArray(data)) {
        this.logger.warn('NoFluffJobs returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`NoFluffJobs returned ${data.length} postings`);

      const jobs: JobPostDto[] = [];

      for (const posting of data) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(posting, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(posting);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping NoFluffJobs posting ${posting.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`NoFluffJobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`NoFluffJobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Check whether a posting matches the given search term.
   */
  private matchesSearch(posting: NoFluffJobsPosting, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (posting.title ?? '').toLowerCase();
    const technology = (posting.technology ?? '').toLowerCase();
    const category = (posting.category ?? '').toLowerCase();

    return title.includes(term) || technology.includes(term) || category.includes(term);
  }

  /**
   * Map a NoFluffJobs posting to a JobPostDto.
   */
  private mapJob(posting: NoFluffJobsPosting): JobPostDto | null {
    if (!posting.title || !posting.id) return null;

    const jobUrl = `https://nofluffjobs.com/job/${posting.url || posting.id}`;

    // Build location from first places[] entry
    const location = this.parseLocation(posting);

    // Build compensation from salary object
    const compensation = this.parseCompensation(posting);

    // Parse date from Unix epoch milliseconds
    let datePosted: string | undefined;
    if (posting.posted) {
      try {
        datePosted = toDateOnly(posting.posted) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Build description from available fields
    const description = this.buildDescription(posting);

    // Remote status from location.fullyRemote
    const isRemote = posting.location?.fullyRemote ?? false;

    return new JobPostDto({
      id: `nofluffjobs-${posting.id}`,
      title: posting.title,
      companyName: posting.name ?? null,
      jobUrl,
      location,
      description,
      compensation: compensation ?? undefined,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.NOFLUFFJOBS,
    });
  }

  /**
   * Parse location from the first places[] entry in the posting.
   */
  private parseLocation(posting: NoFluffJobsPosting): LocationDto {
    const places = posting.location?.places;
    if (!places || places.length === 0) {
      return new LocationDto({});
    }

    const firstPlace = places[0];

    return new LocationDto({
      city: firstPlace.city ?? null,
      country: firstPlace.country?.name ?? null,
    });
  }

  /**
   * Parse salary into a CompensationDto.
   * NoFluffJobs reports annual salaries.
   */
  private parseCompensation(posting: NoFluffJobsPosting): CompensationDto | null {
    const salary = posting.salary;
    if (!salary || (!salary.from && !salary.to)) return null;

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount: salary.from ?? null,
      maxAmount: salary.to ?? null,
      currency: salary.currency ?? 'PLN',
    });
  }

  /**
   * Build a description string from the posting fields.
   */
  private buildDescription(posting: NoFluffJobsPosting): string | undefined {
    const parts: string[] = [];

    if (posting.category) {
      parts.push(`Category: ${posting.category}`);
    }
    if (posting.technology) {
      parts.push(`Technology: ${posting.technology}`);
    }
    if (posting.seniority && posting.seniority.length > 0) {
      parts.push(`Seniority: ${posting.seniority.join(', ')}`);
    }
    if (posting.salary) {
      const sal = posting.salary;
      const range = sal.from && sal.to
        ? `${sal.from} - ${sal.to} ${sal.currency ?? 'PLN'}`
        : sal.from
          ? `from ${sal.from} ${sal.currency ?? 'PLN'}`
          : `up to ${sal.to} ${sal.currency ?? 'PLN'}`;
      parts.push(`Salary (${sal.type ?? 'n/a'}): ${range}`);
    }
    if (posting.regions && posting.regions.length > 0) {
      parts.push(`Regions: ${posting.regions.join(', ')}`);
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
