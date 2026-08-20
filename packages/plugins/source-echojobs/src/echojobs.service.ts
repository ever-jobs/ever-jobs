import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
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
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import { ECHOJOBS_API_URL, ECHOJOBS_HEADERS } from './echojobs.constants';
import { EchoJobsResponse, EchoJob } from './echojobs.types';

@SourcePlugin({
  site: Site.ECHOJOBS,
  name: 'EchoJobs',
  category: 'niche',
})
@Injectable()
export class EchoJobsService implements IScraper {
  private readonly logger = new Logger(EchoJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ECHOJOBS_HEADERS);

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;

    this.logger.log(
      `Fetching EchoJobs jobs (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get<EchoJobsResponse | EchoJob[]>(
        ECHOJOBS_API_URL,
      );

      const data = response.data;

      // Handle response: could be a raw array or an object with jobs/data field
      let rawJobs: EchoJob[] = [];
      if (Array.isArray(data)) {
        rawJobs = data;
      } else if (data && typeof data === 'object') {
        rawJobs = data.jobs ?? data.data ?? [];
      }

      if (rawJobs.length === 0) {
        this.logger.log('No jobs returned from EchoJobs');
        return new JobResponseDto([]);
      }

      this.logger.log(`EchoJobs returned ${rawJobs.length} raw jobs`);

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          // Filter by search term if provided (title match)
          if (input.searchTerm && !this.matchesSearch(raw, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping EchoJobs job ${raw.id}: ${err.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`EchoJobs scrape error: ${err.message}`);
      diagnostics = classifyScrapeError(err);
    }

    this.logger.log(`EchoJobs returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Check whether a job matches the given search term (title match).
   */
  private matchesSearch(raw: EchoJob, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (raw.title ?? '').toLowerCase();
    return title.includes(term);
  }

  /**
   * Map a raw EchoJobs job to a JobPostDto.
   */
  private mapJob(
    raw: EchoJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.title || !raw.url) return null;

    // Process description
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: raw.location ?? null,
    });

    // Build compensation from salary fields
    let compensation: CompensationDto | null = null;
    if (raw.salary_min || raw.salary_max) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: raw.salary_min ?? null,
        maxAmount: raw.salary_max ?? null,
        currency: raw.salary_currency ?? 'USD',
      });
    }

    // Parse date
    const datePosted = raw.date_posted ?? raw.published_at ?? null;

    return new JobPostDto({
      id: `echojobs-${raw.id}`,
      title: raw.title,
      companyName: raw.company ?? null,
      companyLogo: raw.company_logo ?? null,
      jobUrl: raw.url,
      location,
      description,
      compensation,
      datePosted,
      isRemote: raw.is_remote ?? raw.remote ?? false,
      emails: extractEmails(description),
      skills: raw.tags?.length ? raw.tags : null,
      site: Site.ECHOJOBS,
    });
  }
}
