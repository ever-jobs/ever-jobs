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
  HEADHUNTER_API_URL,
  HEADHUNTER_DEFAULT_RESULTS,
  HEADHUNTER_HEADERS,
} from './headhunter.constants';
import { HeadhunterVacancy, HeadhunterApiResponse } from './headhunter.types';

@SourcePlugin({
  site: Site.HEADHUNTER,
  name: 'HeadHunter',
  category: 'regional',
})
@Injectable()
export class HeadhunterService implements IScraper {
  private readonly logger = new Logger(HeadhunterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? HEADHUNTER_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HEADHUNTER_HEADERS);

    const url = this.buildUrl(input.searchTerm, resultsWanted);

    this.logger.log(
      `Fetching HeadHunter API (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(url);
      const data: HeadhunterApiResponse = response.data;

      if (!data || !Array.isArray(data.items)) {
        this.logger.warn('HeadHunter returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`HeadHunter returned ${data.items.length} vacancies`);

      const jobs: JobPostDto[] = [];

      for (const vacancy of data.items) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(vacancy);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping HeadHunter vacancy ${vacancy.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`HeadHunter returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`HeadHunter scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Build the HeadHunter API URL with query parameters.
   */
  private buildUrl(searchTerm: string | undefined, resultsWanted: number): string {
    if (searchTerm) {
      return `${HEADHUNTER_API_URL}?text=${encodeURIComponent(searchTerm)}&per_page=${resultsWanted}&page=0`;
    }
    return `${HEADHUNTER_API_URL}?per_page=${resultsWanted}&page=0`;
  }

  /**
   * Map a HeadHunter vacancy to a JobPostDto.
   */
  private mapJob(vacancy: HeadhunterVacancy): JobPostDto | null {
    if (!vacancy.name || !vacancy.id) return null;

    // Build location
    const location = new LocationDto({
      city: vacancy.area?.name ?? null,
      country: 'Russia',
    });

    // Build compensation from salary
    const compensation = this.parseCompensation(vacancy);

    // Build description from snippet
    const description = this.buildDescription(vacancy);

    // Parse date
    let datePosted: string | undefined;
    if (vacancy.published_at) {
      try {
        datePosted = toDateOnly(vacancy.published_at) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Check remote status
    const isRemote = this.checkRemote(vacancy);

    return new JobPostDto({
      id: `headhunter-${vacancy.id}`,
      title: vacancy.name,
      jobUrl: vacancy.alternate_url ?? '',
      companyName: vacancy.employer?.name ?? null,
      location,
      description,
      compensation: compensation ?? undefined,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.HEADHUNTER,
    });
  }

  /**
   * Parse salary into a CompensationDto.
   * HeadHunter reports monthly salaries.
   */
  private parseCompensation(vacancy: HeadhunterVacancy): CompensationDto | null {
    const salary = vacancy.salary;
    if (!salary || (!salary.from && !salary.to)) return null;

    return new CompensationDto({
      interval: CompensationInterval.MONTHLY,
      minAmount: salary.from ?? null,
      maxAmount: salary.to ?? null,
      currency: salary.currency ?? 'RUR',
    });
  }

  /**
   * Build a description string from the vacancy snippet fields.
   */
  private buildDescription(vacancy: HeadhunterVacancy): string | undefined {
    const parts: string[] = [];

    if (vacancy.snippet?.requirement) {
      parts.push(`Requirements: ${vacancy.snippet.requirement}`);
    }
    if (vacancy.snippet?.responsibility) {
      parts.push(`Responsibilities: ${vacancy.snippet.responsibility}`);
    }

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /**
   * Check if a vacancy is remote based on schedule and work_format fields.
   */
  private checkRemote(vacancy: HeadhunterVacancy): boolean {
    if (vacancy.schedule?.id === 'remote') return true;

    if (vacancy.work_format && Array.isArray(vacancy.work_format)) {
      return vacancy.work_format.some(
        (wf) => wf.id?.toUpperCase() === 'REMOTE',
      );
    }

    return false;
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
