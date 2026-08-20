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
import {
  JOBDATAAPI_API_URL,
  JOBDATAAPI_HEADERS,
  JOBDATAAPI_DEFAULT_PAGE_SIZE,
  JOBDATAAPI_DEFAULT_RESULTS,
} from './jobdataapi.constants';
import { JobDataApiResponse, JobDataApiJob } from './jobdataapi.types';

@SourcePlugin({
  site: Site.JOBDATAAPI,
  name: 'JobDataAPI',
  category: 'job-board',
})
@Injectable()
export class JobDataApiService implements IScraper {
  private readonly logger = new Logger(JobDataApiService.name);
  private readonly defaultApiKey: string | null;

  constructor() {
    this.defaultApiKey = process.env.JOBDATAAPI_API_KEY ?? null;
    if (!this.defaultApiKey) {
      this.logger.warn(
        'JOBDATAAPI_API_KEY is not set. JobDataAPI searches will work with limited rate (10 req/hour). ' +
          'Get your key at https://jobdataapi.com/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = this.defaultApiKey;
    const resultsWanted = input.resultsWanted ?? JOBDATAAPI_DEFAULT_RESULTS;
    const pageSize = Math.min(resultsWanted, JOBDATAAPI_DEFAULT_PAGE_SIZE);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const headers: Record<string, string> = { ...JOBDATAAPI_HEADERS };
    if (apiKey) {
      headers.Authorization = `Api-Key ${apiKey}`;
    }
    client.setHeaders(headers);

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      const params: Record<string, string | number> = {
        page,
        page_size: pageSize,
      };

      if (input.searchTerm) {
        params.title = input.searchTerm;
      }
      if (input.location) {
        params.location_search = input.location;
      }

      this.logger.log(`Fetching JobDataAPI jobs (page=${page}, pageSize=${pageSize})`);

      try {
        const response = await client.get(JOBDATAAPI_API_URL, { params });
        const data = response.data as JobDataApiResponse;

        const rawJobs = data?.results ?? [];
        if (rawJobs.length === 0) {
          this.logger.log('No more JobDataAPI jobs available');
          break;
        }

        this.logger.log(
          `JobDataAPI returned ${rawJobs.length} jobs (total: ${data?.count ?? 'unknown'})`,
        );

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `jobdataapi-${raw.id}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping JobDataAPI job ${raw.id}: ${err.message}`);
          }
        }

        // Stop if no next page
        if (!data?.next) break;

        page++;
      } catch (err: any) {
        this.logger.error(`JobDataAPI scrape error: ${err.message}`);
        diagnostics = classifyScrapeError(err);
        break;
      }
    }

    this.logger.log(`JobDataAPI returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Map a raw JobDataAPI job to a JobPostDto.
   */
  private mapJob(raw: JobDataApiJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    const jobUrl = raw.application_url || `https://jobdataapi.com/jobs/${raw.slug}/`;
    if (!raw.title) return null;

    // Process description (JobDataAPI returns HTML)
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
      // HTML format: pass through as-is
    }

    // Build location from nested location object
    const location = new LocationDto({
      city: raw.location?.city ?? null,
      country: raw.location?.country ?? null,
    });

    // Build compensation from salary fields
    let compensation: CompensationDto | null = null;
    const hasMin = raw.salary_min != null && raw.salary_min !== 0;
    const hasMax = raw.salary_max != null && raw.salary_max !== 0;
    if (hasMin || hasMax) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: raw.salary_min ?? null,
        maxAmount: raw.salary_max ?? null,
        currency: raw.salary_currency ?? 'USD',
      });
    }

    // Parse date
    let datePosted: string | null = null;
    if (raw.date_posted) {
      try {
        datePosted = toDateOnly(raw.date_posted);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `jobdataapi-${raw.id}`,
      title: raw.title,
      companyName: raw.company?.name ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      jobType: null,
      isRemote: raw.has_remote ?? false,
      emails: extractEmails(description),
      skills: raw.tags && raw.tags.length > 0 ? raw.tags : null,
      site: Site.JOBDATAAPI,
    });
  }
}
