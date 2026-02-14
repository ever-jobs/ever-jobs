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
  JobType,
} from '@ever-jobs/models';
import { createHttpClient, htmlToPlainText, markdownConverter, extractEmails } from '@ever-jobs/common';
import { REMOTIVE_API_URL, REMOTIVE_HEADERS } from './remotive.constants';
import { RemotiveApiResponse, RemotiveJob } from './remotive.types';

/** Map Remotive job_type strings to our JobType enum. */
const JOB_TYPE_MAP: Record<string, JobType> = {
  full_time: JobType.FULL_TIME,
  part_time: JobType.PART_TIME,
  contract: JobType.CONTRACT,
  freelance: JobType.CONTRACT,
  internship: JobType.INTERNSHIP,
  temporary: JobType.TEMPORARY,
  volunteer: JobType.VOLUNTEER,
  other: JobType.OTHER,
};

/**
 * Regex to parse salary strings like "$60,000 - $80,000".
 * Uses non-overlapping number pattern (\d{1,3}(?:,\d{3})*|\d+) instead of
 * [\d,]+ to prevent super-linear backtracking (ReDoS).
 */
const SALARY_REGEX = /\$?(\d{1,3}(?:,\d{3})*|\d+)\s*[-\u2013]\s*\$?(\d{1,3}(?:,\d{3})*|\d+)/;

@Injectable()
export class RemotiveService implements IScraper {
  private readonly logger = new Logger(RemotiveService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 100;

    this.logger.log(
      `Remotive scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      // Build query params
      const params: Record<string, string | number> = {
        limit,
      };
      if (input.searchTerm) {
        params.search = input.searchTerm;
      }

      const response = await http.get<RemotiveApiResponse>(REMOTIVE_API_URL, {
        headers: REMOTIVE_HEADERS,
        params,
      });

      const data = response.data;
      if (!data?.jobs || !Array.isArray(data.jobs)) {
        this.logger.warn('Remotive returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`Remotive returned ${data.jobs.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const entry of data.jobs) {
        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Remotive job ${entry.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Remotive scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw Remotive API job object to a JobPostDto.
   */
  private mapJob(
    entry: RemotiveJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.title || !entry.url) {
      return null;
    }

    // Process description (Remotive returns HTML)
    let description: string | null = entry.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse salary
    const compensation = this.parseSalary(entry.salary);

    // Build location
    const location = new LocationDto({
      city: entry.candidate_required_location || null,
    });

    // Map job type
    const jobType = this.mapJobType(entry.job_type);

    // Parse date (extract date part from ISO 8601)
    const datePosted = entry.publication_date
      ? entry.publication_date.split('T')[0]
      : null;

    // Prefer company_logo_url, fall back to company_logo
    const companyLogo = entry.company_logo_url || entry.company_logo || null;

    return new JobPostDto({
      id: `remotive-${entry.id}`,
      title: entry.title,
      companyName: entry.company_name || null,
      companyLogo,
      jobUrl: entry.url,
      location,
      description,
      compensation,
      datePosted,
      jobType: jobType ? [jobType] : null,
      isRemote: true,
      emails: extractEmails(description),
      site: Site.REMOTIVE,
      skills: entry.tags?.length > 0 ? entry.tags : null,
    });
  }

  /**
   * Parse a salary string like "$60,000 - $80,000" into a CompensationDto.
   */
  private parseSalary(salary: string | null | undefined): CompensationDto | null {
    if (!salary) {
      return null;
    }

    const match = salary.match(SALARY_REGEX);
    if (!match) {
      return null;
    }

    const minAmount = parseInt(match[1].replace(/,/g, ''), 10);
    const maxAmount = parseInt(match[2].replace(/,/g, ''), 10);

    if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0) {
      return null;
    }

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount,
      maxAmount,
      currency: 'USD',
    });
  }

  /**
   * Map a Remotive job_type string to our JobType enum.
   */
  private mapJobType(jobType: string | null | undefined): JobType | null {
    if (!jobType) {
      return null;
    }
    const normalized = jobType.toLowerCase().trim();
    return JOB_TYPE_MAP[normalized] ?? null;
  }
}
