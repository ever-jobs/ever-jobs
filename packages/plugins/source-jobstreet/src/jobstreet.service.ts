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
import { JOBSTREET_API_URL, JOBSTREET_HEADERS } from './jobstreet.constants';
import { JobstreetResponse, JobstreetJob } from './jobstreet.types';

/** Base URL for constructing job detail links. */
const JOBSTREET_BASE_URL = 'https://www.jobstreet.com/job';

/**
 * Regex to parse salary strings like "MYR 5,000 - MYR 8,000".
 * Character classes are atomic, so this runs in linear time.
 * Input length is capped in parseSalary() as additional ReDoS defence.
 */
const SALARY_REGEX = /([A-Z]{3})?\s*\$?([\d,]+)\s*[-\u2013]\s*([A-Z]{3})?\s*\$?([\d,]+)/;

@SourcePlugin({
  site: Site.JOBSTREET,
  name: 'Jobstreet',
  category: 'regional',
})
@Injectable()
export class JobstreetService implements IScraper {
  private readonly logger = new Logger(JobstreetService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBSTREET_HEADERS);

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;

    this.logger.log(
      `Fetching Jobstreet jobs (resultsWanted=${resultsWanted})`,
    );

    try {
      // Build query params
      const params: Record<string, string | number> = {
        siteKey: 'MY-Main',
        pageSize: resultsWanted,
      };
      if (input.searchTerm) {
        params.keywords = input.searchTerm;
      }
      if (input.location) {
        params.where = input.location;
      }

      const response = await client.get<JobstreetResponse | JobstreetJob[]>(
        JOBSTREET_API_URL,
        { params },
      );

      const data = response.data;

      // Handle response: could be a raw array or an object with data/jobs field
      let rawJobs: JobstreetJob[] = [];
      if (Array.isArray(data)) {
        rawJobs = data;
      } else if (data && typeof data === 'object') {
        rawJobs = data.data ?? data.jobs ?? [];
      }

      if (rawJobs.length === 0) {
        this.logger.log('No jobs returned from Jobstreet');
        return new JobResponseDto([]);
      }

      this.logger.log(`Jobstreet returned ${rawJobs.length} raw jobs`);

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Jobstreet job ${raw.id}: ${err.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`Jobstreet scrape error: ${err.message}`);
      diagnostics = classifyScrapeError(err);
    }

    this.logger.log(`Jobstreet returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Map a raw Jobstreet job to a JobPostDto.
   */
  private mapJob(
    raw: JobstreetJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.title) return null;

    // Resolve company name from multiple possible fields
    const companyName =
      raw.advertiser?.description ?? raw.companyName ?? raw.company ?? null;

    // Resolve job URL
    let jobUrl = raw.listingUrl ?? raw.jobUrl ?? null;
    if (!jobUrl && raw.id) {
      jobUrl = `${JOBSTREET_BASE_URL}/${raw.id}`;
    }
    if (!jobUrl) return null;

    // Process description (teaser or full description)
    let description: string | null = raw.teaser ?? raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Resolve location from multiple possible fields
    const locationStr = raw.locationWhereValue ?? raw.location ?? null;
    const location = new LocationDto({
      city: locationStr,
    });

    // Parse salary/compensation
    const compensation = this.parseSalary(raw.salary ?? raw.salaryLabel);

    // Parse date
    const datePosted = raw.listingDate ?? null;

    return new JobPostDto({
      id: `jobstreet-${raw.id}`,
      title: raw.title,
      companyName,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: raw.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.JOBSTREET,
    });
  }

  /**
   * Parse a salary string like "MYR 5,000 - MYR 8,000" into a CompensationDto.
   */
  private parseSalary(
    salary: string | null | undefined,
  ): CompensationDto | null {
    if (!salary || salary.length > 200) {
      return null;
    }

    const match = salary.match(SALARY_REGEX);
    if (!match) {
      return null;
    }

    const currency = match[1] || match[3] || 'MYR';
    const minAmount = parseInt(match[2].replace(/,/g, ''), 10);
    const maxAmount = parseInt(match[4].replace(/,/g, ''), 10);

    if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0) {
      return null;
    }

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount,
      maxAmount,
      currency,
    });
  }
}
