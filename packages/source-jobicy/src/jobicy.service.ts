import { Injectable, Logger } from '@nestjs/common';
import {
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
import { JOBICY_API_URL, JOBICY_HEADERS } from './jobicy.constants';
import { JobicyJob, JobicyApiResponse } from './jobicy.types';

@Injectable()
export class JobicyService implements IScraper {
  private readonly logger = new Logger(JobicyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const count = Math.min(input.resultsWanted ?? 50, 50);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBICY_HEADERS);

    const params: Record<string, string | number> = {
      count,
    };

    if (input.location) {
      params.geo = input.location;
    }
    if (input.searchTerm) {
      params.tag = input.searchTerm;
    }

    this.logger.log(`Fetching Jobicy remote jobs (count=${count})`);

    try {
      const response = await client.get<JobicyApiResponse>(JOBICY_API_URL, {
        params,
      });

      const rawJobs = response.data?.jobs ?? [];
      this.logger.log(`Jobicy returned ${rawJobs.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const raw of rawJobs) {
        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Jobicy job ${raw.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Jobicy scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private mapJob(raw: JobicyJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.jobTitle || !raw.url) return null;

    // Process description (Jobicy returns HTML)
    let description: string | null = raw.jobDescription ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build compensation
    let compensation: CompensationDto | null = null;
    const hasMin = raw.annualSalaryMin != null && raw.annualSalaryMin !== 0;
    const hasMax = raw.annualSalaryMax != null && raw.annualSalaryMax !== 0;
    if (hasMin || hasMax) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: raw.annualSalaryMin ?? null,
        maxAmount: raw.annualSalaryMax ?? null,
        currency: raw.salaryCurrency ?? 'USD',
      });
    }

    // Build location
    const location = new LocationDto({
      city: raw.jobGeo ?? null,
    });

    // Parse date
    let datePosted: string | null = null;
    if (raw.pubDate) {
      try {
        datePosted = new Date(raw.pubDate).toISOString().split('T')[0];
      } catch {
        datePosted = raw.pubDate;
      }
    }

    return new JobPostDto({
      id: `jobicy-${raw.id}`,
      title: raw.jobTitle,
      companyName: raw.companyName ?? null,
      companyLogo: raw.companyLogo ?? null,
      jobUrl: raw.url,
      location,
      description,
      compensation,
      datePosted,
      isRemote: true,
      jobLevel: raw.jobLevel ?? null,
      companyIndustry: raw.jobIndustry?.join(', ') ?? null,
      emails: extractEmails(description),
      site: Site.JOBICY,
    });
  }
}
