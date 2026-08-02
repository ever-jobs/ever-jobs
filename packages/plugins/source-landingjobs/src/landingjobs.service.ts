import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  CompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  LANDINGJOBS_API_URL,
  LANDINGJOBS_PAGE_SIZE,
  LANDINGJOBS_MAX_PAGES,
  LANDINGJOBS_HEADERS,
} from './landingjobs.constants';
import { LandingJob } from './landingjobs.types';

@SourcePlugin({
  site: Site.LANDINGJOBS,
  name: 'LandingJobs',
  category: 'niche',
})
@Injectable()
export class LandingJobsService implements IScraper {
  private readonly logger = new Logger(LandingJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(LANDINGJOBS_HEADERS);

    const jobs: JobPostDto[] = [];
    let offset = 0;
    let page = 0;

    this.logger.log(
      `Fetching Landing.jobs jobs (resultsWanted=${resultsWanted}, search="${input.searchTerm ?? ''}")`,
    );

    try {
      while (jobs.length < resultsWanted && page < LANDINGJOBS_MAX_PAGES) {
        this.logger.log(`Fetching Landing.jobs offset=${offset} limit=${LANDINGJOBS_PAGE_SIZE}`);

        const response = await client.get(LANDINGJOBS_API_URL, {
          params: {
            offset,
            limit: LANDINGJOBS_PAGE_SIZE,
          },
        });

        const rawJobs: LandingJob[] = Array.isArray(response.data)
          ? response.data
          : [];

        if (rawJobs.length === 0) {
          this.logger.log('No more jobs returned from Landing.jobs');
          break;
        }

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          try {
            // Filter by search term if provided
            if (input.searchTerm && !this.matchesSearch(raw, input.searchTerm)) {
              continue;
            }

            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(
              `Error mapping Landing.jobs job ${raw.id}: ${err.message}`,
            );
          }
        }

        // If we received fewer than the page size, no more pages available
        if (rawJobs.length < LANDINGJOBS_PAGE_SIZE) break;

        offset += LANDINGJOBS_PAGE_SIZE;
        page++;
      }
    } catch (err: any) {
      this.logger.error(`Landing.jobs scrape error: ${err.message}`);
    }

    this.logger.log(`Landing.jobs returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs);
  }

  /**
   * Check whether a job matches the given search term (case-insensitive).
   */
  private matchesSearch(raw: LandingJob, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (raw.title ?? '').toLowerCase();
    const description = (raw.role_description ?? '').toLowerCase();
    const tags = (raw.tags ?? []).map((t) => t.toLowerCase()).join(' ');

    return (
      title.includes(term) ||
      description.includes(term) ||
      tags.includes(term)
    );
  }

  /**
   * Map a raw Landing.jobs API job to a JobPostDto.
   */
  private mapJob(
    raw: LandingJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.title) return null;

    // Process description (Landing.jobs role_description may contain HTML)
    let description: string | null = raw.role_description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: raw.city ?? null,
      country: raw.country_name ?? null,
    });

    // Build compensation from salary_low/salary_high
    let compensation: CompensationDto | null = null;
    if (raw.salary_low != null || raw.salary_high != null) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: raw.salary_low ?? null,
        maxAmount: raw.salary_high ?? null,
        currency: raw.currency_code ?? 'EUR',
      });
    }

    // Parse date from published_at (ISO 8601 string)
    let datePosted: string | null = null;
    if (raw.published_at) {
      try {
        datePosted = toDateOnly(raw.published_at);
      } catch {
        datePosted = null;
      }
    }

    // Build job URL
    const jobUrl = `https://landing.jobs/jobs/${raw.id}`;

    return new JobPostDto({
      id: `landingjobs-${raw.id}`,
      title: raw.title,
      companyName: null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: raw.remote ?? false,
      skills: raw.tags ?? null,
      emails: extractEmails(description),
      site: Site.LANDINGJOBS,
    });
  }
}
