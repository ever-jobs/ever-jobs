import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  JobType,
  getJobTypeFromString,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
} from '@ever-jobs/common';
import {
  JOOBLE_API_BASE_URL,
  JOOBLE_HEADERS,
  JOOBLE_DEFAULT_PAGE_SIZE,
  JOOBLE_DEFAULT_RESULTS,
} from './jooble.constants';
import { JoobleResponse, JoobleJob } from './jooble.types';

/** Safe regex for parsing salary ranges like "$80,000 - $120,000" */
const SALARY_RANGE_REGEX = /\$?(\d{1,3}(?:,\d{3})*|\d+)\s*[-\u2013]\s*\$?(\d{1,3}(?:,\d{3})*|\d+)/;

@Injectable()
export class JoobleService implements IScraper {
  private readonly logger = new Logger(JoobleService.name);
  private readonly defaultApiKey: string | null;

  constructor() {
    this.defaultApiKey = process.env.JOOBLE_API_KEY ?? null;
    if (!this.defaultApiKey) {
      this.logger.warn(
        'JOOBLE_API_KEY is not set. Jooble searches will return empty results ' +
          'unless per-request auth is provided via input.auth.jooble. ' +
          'Get your key at https://jooble.org/api/about',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = input.auth?.jooble?.apiKey ?? this.defaultApiKey;

    if (!apiKey) {
      this.logger.warn('Skipping Jooble search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? JOOBLE_DEFAULT_RESULTS;
    const apiUrl = `${JOOBLE_API_BASE_URL}/${apiKey}`;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOOBLE_HEADERS);

    const jobs: JobPostDto[] = [];
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      const pageSize = Math.min(JOOBLE_DEFAULT_PAGE_SIZE, resultsWanted - jobs.length);

      this.logger.log(`Fetching Jooble jobs (page=${page}, pageSize=${pageSize})`);

      try {
        const body: Record<string, string | number> = {
          page,
          ResultOnPage: pageSize,
        };

        if (input.searchTerm) {
          body.keywords = input.searchTerm;
        }
        if (input.location) {
          body.location = input.location;
        }

        const response = await client.post<JoobleResponse>(apiUrl, body);

        const rawJobs = response.data?.jobs ?? [];
        if (rawJobs.length === 0) {
          this.logger.log('No more Jooble jobs available');
          break;
        }

        this.logger.log(
          `Jooble returned ${rawJobs.length} jobs (total available: ${response.data?.totalCount ?? 'unknown'})`,
        );

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `jooble-${raw.id}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping Jooble job ${raw.id}: ${err.message}`);
          }
        }

        page++;

        // Stop if we got fewer results than requested (last page)
        if (rawJobs.length < pageSize) break;
      } catch (err: any) {
        this.logger.error(`Jooble scrape error: ${err.message}`);
        break;
      }
    }

    return new JobResponseDto(jobs);
  }

  private mapJob(raw: JoobleJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.link) return null;

    // Process description — Jooble snippet is plain text, pass through for all formats
    const description: string | null = raw.snippet ?? null;

    // Build compensation by parsing the salary string
    let compensation: CompensationDto | null = null;
    if (raw.salary) {
      compensation = this.parseSalary(raw.salary);
    }

    // Build location
    const location = new LocationDto({
      city: raw.location ?? null,
    });

    // Parse date (ISO format)
    let datePosted: string | null = null;
    if (raw.updated) {
      try {
        datePosted = new Date(raw.updated).toISOString().split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    // Parse job type
    let jobType: JobType[] | null = null;
    if (raw.type) {
      const parsed = getJobTypeFromString(raw.type);
      if (parsed) {
        jobType = [parsed];
      }
    }

    // Detect remote from title, snippet, or type
    const textToScan = `${raw.title} ${raw.snippet ?? ''} ${raw.type ?? ''}`.toLowerCase();
    const isRemote =
      textToScan.includes('remote') ||
      textToScan.includes('work from home') ||
      textToScan.includes('wfh');

    return new JobPostDto({
      id: `jooble-${raw.id}`,
      title: raw.title,
      companyName: raw.company ?? null,
      companyUrl: null,
      jobUrl: raw.link,
      location,
      description,
      compensation,
      datePosted,
      jobType,
      isRemote,
      emails: extractEmails(description),
      site: Site.JOOBLE,
    });
  }

  /**
   * Parse a salary string into a CompensationDto.
   * Handles formats like "$80,000 - $120,000", "80000", or empty strings.
   */
  private parseSalary(salary: string): CompensationDto | null {
    if (!salary || !salary.trim()) return null;

    const rangeMatch = salary.match(SALARY_RANGE_REGEX);
    if (rangeMatch) {
      const minAmount = parseInt(rangeMatch[1].replace(/,/g, ''), 10);
      const maxAmount = parseInt(rangeMatch[2].replace(/,/g, ''), 10);
      if (!isNaN(minAmount) && !isNaN(maxAmount)) {
        return new CompensationDto({
          interval: CompensationInterval.YEARLY,
          minAmount,
          maxAmount,
          currency: 'USD',
        });
      }
    }

    // Try to parse a single number
    const singleMatch = salary.match(/\$?(\d{1,3}(?:,\d{3})*|\d+)/);
    if (singleMatch) {
      const amount = parseInt(singleMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(amount) && amount > 0) {
        return new CompensationDto({
          interval: CompensationInterval.YEARLY,
          minAmount: amount,
          maxAmount: null,
          currency: 'USD',
        });
      }
    }

    return null;
  }
}
