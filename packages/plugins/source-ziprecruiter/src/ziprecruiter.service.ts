import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, CompensationDto, CompensationInterval, JobType,
  DescriptionFormat, Site, getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient, ZipRecruiterException, markdownConverter, plainConverter,
  extractEmails, randomSleep,
} from '@ever-jobs/common';
import { ZIPRECRUITER_HEADERS, SESSION_EVENT_DATA } from './ziprecruiter.constants';

@SourcePlugin({
  site: Site.ZIP_RECRUITER,
  name: 'ZipRecruiter',
  category: 'job-board',
})
@Injectable()
export class ZipRecruiterService implements IScraper {
  private readonly logger = new Logger(ZipRecruiterService.name);
  private readonly baseUrl = 'https://api.ziprecruiter.com/jobs-app/jobs';
  private readonly delay = 5;
  private readonly bandDelay = 5;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient(input);
    client.setHeaders(ZIPRECRUITER_HEADERS);

    // Initialize session
    try {
      await client.post('https://api.ziprecruiter.com/jobs-app/event', SESSION_EVENT_DATA);
    } catch (err: any) {
      this.logger.warn(`ZipRecruiter session init failed: ${err.message}`);
    }

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    let continueToken: string | null = null;
    const seenIds = new Set<string>();

    while (jobList.length < resultsWanted) {
      this.logger.log(`Fetching ZipRecruiter jobs, page ${Math.floor(jobList.length / 20) + 1}`);

      try {
        const params = this.buildParams(input, continueToken);
        const response = await client.get(this.baseUrl, { params });
        const data = response.data;

        const jobs = data.jobs ?? [];
        continueToken = data.continue_token ?? null;

        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (jobList.length >= resultsWanted) break;
          const jobId = job.job_id ?? job.id;
          if (!jobId || seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const jobPost = this.processJob(job, input.descriptionFormat);
            if (jobPost) jobList.push(jobPost);
          } catch (err: any) {
            this.logger.warn(`Error processing ZipRecruiter job: ${err.message}`);
          }
        }

        if (!continueToken) break;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`ZipRecruiter scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    return new JobResponseDto(jobList, diagnostics);
  }

  private buildParams(input: ScraperInputDto, continueToken: string | null): Record<string, any> {
    const params: Record<string, any> = {
      search: input.searchTerm ?? '',
      location: input.location ?? '',
      radius_miles: input.distance ?? 50,
      form: 'jobs-landing',
    };
    if (continueToken) params.continue_token = continueToken;
    if (input.hoursOld) params.days_ago = Math.ceil(input.hoursOld / 24);
    if (input.jobType) {
      const typeMap: Record<string, string> = {
        fulltime: 'full_time',
        parttime: 'part_time',
        contract: 'contractor',
        internship: 'intern',
        temporary: 'temporary',
      };
      params.employment_type = typeMap[input.jobType] ?? '';
    }
    return params;
  }

  private processJob(job: any, format?: DescriptionFormat): JobPostDto | null {
    const title = job.name ?? job.title;
    if (!title) return null;

    let description = job.job_description ?? job.snippet ?? null;
    if (description) {
      if (format === DescriptionFormat.MARKDOWN) description = markdownConverter(description) ?? description;
      else if (format === DescriptionFormat.PLAIN) description = plainConverter(description) ?? description;
    }

    const location = new LocationDto({
      city: job.job_city ?? null,
      state: job.job_state ?? null,
      country: job.job_country ?? null,
    });

    let compensation: CompensationDto | null = null;
    if (job.salary_min_annual || job.salary_max_annual) {
      compensation = new CompensationDto({
        minAmount: job.salary_min_annual ?? null,
        maxAmount: job.salary_max_annual ?? null,
        interval: CompensationInterval.YEARLY,
        currency: 'USD',
      });
    }

    const employmentType = (job.employment_type ?? '').toLowerCase();
    const jobType = getJobTypeFromString(employmentType.replace('_', ''));
    const remote = (job.remote ?? '').toLowerCase() === 'true' || false;

    return new JobPostDto({
      id: `zr-${job.job_id ?? job.id}`,
      title,
      companyName: job.hiring_company?.name ?? null,
      companyUrl: job.hiring_company?.url ?? null,
      jobUrl: job.job_url ?? job.url ?? '',
      jobUrlDirect: job.apply_url ?? null,
      location,
      compensation,
      description,
      datePosted: job.posted_time ?? null,
      isRemote: remote,
      jobType: jobType ? [jobType] : null,
      emails: extractEmails(description),
      companyLogo: job.hiring_company?.logo ?? null,
      site: Site.ZIP_RECRUITER,
    });
  }
}
