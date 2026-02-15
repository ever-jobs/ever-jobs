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
  Site,
  Country,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  ADZUNA_API_BASE_URL,
  ADZUNA_HEADERS,
  ADZUNA_MAX_PAGE_SIZE,
  ADZUNA_DEFAULT_RESULTS,
  ADZUNA_RATE_LIMIT_PER_MINUTE,
  COUNTRY_TO_ADZUNA,
  ADZUNA_DEFAULT_COUNTRY,
} from './adzuna.constants';
import { AdzunaResponse, AdzunaJob } from './adzuna.types';

/**
 * Map Adzuna contract_time values to JobType.
 */
const CONTRACT_TIME_MAP: Record<string, JobType> = {
  full_time: JobType.FULL_TIME,
  part_time: JobType.PART_TIME,
  contract: JobType.CONTRACT,
};

@Injectable()
export class AdzunaService implements IScraper {
  private readonly logger = new Logger(AdzunaService.name);
  private readonly defaultAppId: string | null;
  private readonly defaultAppKey: string | null;
  private requestCount = 0;

  constructor() {
    this.defaultAppId = process.env.ADZUNA_APP_ID ?? null;
    this.defaultAppKey = process.env.ADZUNA_APP_KEY ?? null;
    if (!this.defaultAppId || !this.defaultAppKey) {
      this.logger.warn(
        'ADZUNA_APP_ID or ADZUNA_APP_KEY not set. Adzuna searches will return empty results ' +
          'unless per-request auth is provided via input.auth.adzuna. ' +
          'Sign up at https://developer.adzuna.com/signup',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const appId = input.auth?.adzuna?.appId ?? this.defaultAppId;
    const appKey = input.auth?.adzuna?.appKey ?? this.defaultAppKey;

    if (!appId || !appKey) {
      this.logger.warn('Skipping Adzuna search — credentials not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? ADZUNA_DEFAULT_RESULTS;
    const pageSize = Math.min(resultsWanted, ADZUNA_MAX_PAGE_SIZE);

    // Resolve country code for the API URL
    const countryCode = this.resolveCountryCode(input.country);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ADZUNA_HEADERS);

    const jobs: JobPostDto[] = [];
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      // Rate limit warning
      this.requestCount++;
      if (this.requestCount >= ADZUNA_RATE_LIMIT_PER_MINUTE) {
        this.logger.warn(
          `Approaching Adzuna rate limit (${this.requestCount} requests). ` +
            `Limit is ${ADZUNA_RATE_LIMIT_PER_MINUTE}/min.`,
        );
      }

      const url = `${ADZUNA_API_BASE_URL}/${countryCode}/search/${page}`;

      const params: Record<string, string | number> = {
        app_id: appId,
        app_key: appKey,
        results_per_page: pageSize,
        sort_by: 'date',
      };

      if (input.searchTerm) {
        params.what = input.searchTerm;
      }

      if (input.location) {
        params.where = input.location;
      }

      if (input.hoursOld) {
        const maxDaysOld = Math.ceil(input.hoursOld / 24);
        params.max_days_old = maxDaysOld;
      }

      this.logger.log(`Fetching Adzuna jobs (country=${countryCode}, page=${page}, pageSize=${pageSize})`);

      try {
        const response = await client.get<AdzunaResponse>(url, { params });

        const results = response.data?.results ?? [];
        if (results.length === 0) {
          this.logger.log('No more Adzuna results available');
          break;
        }

        this.logger.log(
          `Adzuna returned ${results.length} results (total: ${response.data?.count ?? 'unknown'})`,
        );

        for (const raw of results) {
          if (jobs.length >= resultsWanted) break;

          const jobId = raw.id?.toString();
          if (!jobId) continue;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping Adzuna job ${jobId}: ${err.message}`);
          }
        }

        // Stop if we got fewer results than requested (last page)
        if (results.length < pageSize) break;

        page++;
      } catch (err: any) {
        this.logger.error(`Adzuna scrape error: ${err.message}`);
        break;
      }
    }

    return new JobResponseDto(jobs);
  }

  /**
   * Resolve Country enum to Adzuna 2-letter country code.
   */
  private resolveCountryCode(country?: Country | null): string {
    if (!country) return ADZUNA_DEFAULT_COUNTRY;
    return COUNTRY_TO_ADZUNA[country] ?? ADZUNA_DEFAULT_COUNTRY;
  }

  /**
   * Map an Adzuna job result to a JobPostDto.
   */
  private mapJob(raw: AdzunaJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    // jobUrl is REQUIRED — skip if missing
    const jobUrl = raw.redirect_url;
    if (!jobUrl) return null;

    const title = raw.title;
    if (!title) return null;

    // Process description (Adzuna may return light HTML snippets)
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

    // Build location from display_name
    const location = new LocationDto({
      city: raw.location?.display_name ?? null,
    });

    // Build compensation (only use non-predicted salaries)
    let compensation: CompensationDto | null = null;
    if (raw.salary_is_predicted !== '1') {
      const hasMin = raw.salary_min != null && raw.salary_min > 0;
      const hasMax = raw.salary_max != null && raw.salary_max > 0;
      if (hasMin || hasMax) {
        compensation = new CompensationDto({
          interval: CompensationInterval.YEARLY,
          minAmount: hasMin ? raw.salary_min : null,
          maxAmount: hasMax ? raw.salary_max : null,
          currency: 'USD',
        });
      }
    }

    // Parse date
    let datePosted: string | null = null;
    if (raw.created) {
      try {
        datePosted = new Date(raw.created).toISOString().split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    // Map contract_time to JobType
    let jobType: JobType[] | null = null;
    if (raw.contract_time) {
      const mapped = CONTRACT_TIME_MAP[raw.contract_time];
      if (mapped) {
        jobType = [mapped];
      }
    }

    return new JobPostDto({
      id: `adzuna-${raw.id}`,
      title,
      companyName: raw.company?.display_name ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      jobType,
      isRemote: null,
      emails: extractEmails(description),
      site: Site.ADZUNA,
    });
  }
}
