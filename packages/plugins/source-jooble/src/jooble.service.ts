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
  JobType,
  getJobTypeFromString,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  JOOBLE_API_BASE_URL,
  JOOBLE_HEADERS,
  JOOBLE_DEFAULT_PAGE_SIZE,
  JOOBLE_DEFAULT_RESULTS,
} from './jooble.constants';
import { JoobleResponse, JoobleJob } from './jooble.types';

/** Safe regex for parsing salary ranges like "$80,000 - $120,000" or "€3,000 - €5,000" */
const SALARY_RANGE_REGEX = /[$€£₹]?\s*(\d{1,3}(?:,\d{3})*|\d+)\s*[-\u2013]\s*[$€£₹]?\s*(\d{1,3}(?:,\d{3})*|\d+)/;

/** Map currency symbols found in salary strings to ISO 4217 codes */
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  '$': 'USD',
  '\u20AC': 'EUR', // €
  '\u00A3': 'GBP', // £
  '\u20B9': 'INR', // ₹
};

/** Match interval keywords in salary strings */
const INTERVAL_KEYWORDS: Array<[RegExp, CompensationInterval]> = [
  [/\b(?:per\s+hour|\/\s*hr|hourly|\/\s*hour)\b/i, CompensationInterval.HOURLY],
  [/\b(?:per\s+day|\/\s*day|daily)\b/i, CompensationInterval.DAILY],
  [/\b(?:per\s+week|\/\s*wk|weekly)\b/i, CompensationInterval.WEEKLY],
  [/\b(?:per\s+month|\/\s*mo|monthly|p\.?\s*m\.?)\b/i, CompensationInterval.MONTHLY],
  [/\b(?:per\s+year|\/\s*yr|yearly|annual|annually|p\.?\s*a\.?)\b/i, CompensationInterval.YEARLY],
];

@SourcePlugin({
  site: Site.JOOBLE,
  name: 'Jooble',
  category: 'job-board',
})
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
    let diagnostics: ScrapeDiagnostics | undefined;
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
        diagnostics = classifyScrapeError(err);
        break;
      }
    }

    return new JobResponseDto(jobs, diagnostics);
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
        datePosted = toDateOnly(raw.updated);
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
   * Detects currency from symbols ($, €, £, ₹) and interval from keywords
   * (hourly, monthly, yearly, etc.). Falls back to null currency / yearly interval
   * when the string doesn't contain enough hints.
   */
  private parseSalary(salary: string): CompensationDto | null {
    if (!salary || !salary.trim()) return null;

    // Detect currency from symbol
    const currency = this.detectCurrency(salary);

    // Detect interval from keywords
    const interval = this.detectInterval(salary);

    const rangeMatch = salary.match(SALARY_RANGE_REGEX);
    if (rangeMatch) {
      const minAmount = parseInt(rangeMatch[1].replace(/,/g, ''), 10);
      const maxAmount = parseInt(rangeMatch[2].replace(/,/g, ''), 10);
      if (!isNaN(minAmount) && !isNaN(maxAmount)) {
        return new CompensationDto({
          interval,
          minAmount,
          maxAmount,
          currency,
        });
      }
    }

    // Try to parse a single number
    const singleMatch = salary.match(/[$€£₹]?\s*(\d{1,3}(?:,\d{3})*|\d+)/);
    if (singleMatch) {
      const amount = parseInt(singleMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(amount) && amount > 0) {
        return new CompensationDto({
          interval,
          minAmount: amount,
          maxAmount: null,
          currency,
        });
      }
    }

    return null;
  }

  /**
   * Detect ISO 4217 currency code from a salary string's symbol.
   * Returns null when no recognizable symbol is found.
   */
  private detectCurrency(salary: string): string | undefined {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_MAP)) {
      if (salary.includes(symbol)) return code;
    }
    return undefined; // let CompensationDto default handle it
  }

  /**
   * Detect compensation interval from keywords in a salary string.
   * Returns YEARLY as the default when no interval hint is found.
   */
  private detectInterval(salary: string): CompensationInterval {
    for (const [pattern, interval] of INTERVAL_KEYWORDS) {
      if (pattern.test(salary)) return interval;
    }
    return CompensationInterval.YEARLY;
  }
}
