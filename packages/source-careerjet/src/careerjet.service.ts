import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, CompensationDto, CompensationInterval,
  DescriptionFormat, Site,
} from '@ever-jobs/models';
import {
  createHttpClient, markdownConverter, plainConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  CAREERJET_API_URL, CAREERJET_HEADERS, COUNTRY_TO_LOCALE,
  DEFAULT_LOCALE, DEFAULT_USER_AGENT, MAX_PAGE, DEFAULT_PAGE_SIZE,
} from './careerjet.constants';
import { CareerJetResponse, CareerJetJob } from './careerjet.types';

const SALARY_TYPE_MAP: Record<string, CompensationInterval> = {
  'Y': CompensationInterval.YEARLY,
  'M': CompensationInterval.MONTHLY,
  'W': CompensationInterval.WEEKLY,
  'D': CompensationInterval.DAILY,
  'H': CompensationInterval.HOURLY,
};

@Injectable()
export class CareerJetService implements IScraper {
  private readonly logger = new Logger(CareerJetService.name);
  private readonly defaultAffId: string | null;

  constructor() {
    this.defaultAffId = process.env.CAREERJET_AFFID ?? null;
    if (!this.defaultAffId) {
      this.logger.warn(
        'CAREERJET_AFFID is not set. CareerJet searches will return empty results ' +
          'unless per-request auth is provided via input.auth.careerjet. ' +
          'Sign up at https://www.careerjet.com/partners/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const affId = input.auth?.careerjet?.affId ?? this.defaultAffId;

    if (!affId) {
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CAREERJET_HEADERS);

    const jobList: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 15;
    const seenUrls = new Set<string>();

    const locale = input.country
      ? (COUNTRY_TO_LOCALE[input.country] ?? DEFAULT_LOCALE)
      : DEFAULT_LOCALE;

    const userIp = input.clientIp ?? '127.0.0.1';
    const userAgent = input.userAgent ?? DEFAULT_USER_AGENT;
    const pageSize = Math.min(resultsWanted, DEFAULT_PAGE_SIZE);

    for (let page = 1; page <= MAX_PAGE && jobList.length < resultsWanted; page++) {
      this.logger.log(`Fetching CareerJet jobs, page ${page}`);

      try {
        const params: Record<string, any> = {
          affid: affId,
          user_ip: userIp,
          user_agent: userAgent,
          locale_code: locale,
          keywords: input.searchTerm ?? '',
          location: input.location ?? '',
          sort: 'date',
          page,
          pagesize: pageSize,
        };

        const response = await client.get(CAREERJET_API_URL, { params });
        const data: CareerJetResponse = response.data;

        if (!data.jobs || data.jobs.length === 0) break;

        for (const job of data.jobs) {
          if (jobList.length >= resultsWanted) break;

          // jobUrl is REQUIRED -- skip jobs without a URL
          if (!job.url) continue;
          if (seenUrls.has(job.url)) continue;
          seenUrls.add(job.url);

          try {
            const jobPost = this.processJob(job, input.descriptionFormat);
            if (jobPost) jobList.push(jobPost);
          } catch (err: any) {
            this.logger.warn(`Error processing CareerJet job: ${err.message}`);
          }
        }

        // If we got fewer results than the page size, there are no more pages
        if (data.jobs.length < pageSize) break;
        // If we've reached the last page reported by the API
        if (page >= data.pages) break;
      } catch (err: any) {
        this.logger.error(`CareerJet scrape error: ${err.message}`);
        break;
      }
    }

    return new JobResponseDto(jobList);
  }

  private processJob(job: CareerJetJob, format?: DescriptionFormat): JobPostDto | null {
    if (!job.title) return null;

    let description: string | null = job.description ?? null;
    if (description) {
      if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      } else if (format === DescriptionFormat.PLAIN) {
        description = plainConverter(description) ?? description;
      }
      // HTML format: pass through as-is
    }

    const location = new LocationDto({
      city: job.locations ?? null,
      state: null,
      country: null,
    });

    let compensation: CompensationDto | null = null;
    if (job.salary_min > 0) {
      compensation = new CompensationDto({
        minAmount: job.salary_min ?? null,
        maxAmount: job.salary_max > 0 ? job.salary_max : null,
        interval: SALARY_TYPE_MAP[job.salary_type] ?? CompensationInterval.YEARLY,
        currency: job.salary_currency_code ?? null,
      });
    }

    // Parse date string to YYYY-MM-DD
    let datePosted: string | null = null;
    if (job.date) {
      try {
        const parsed = new Date(job.date);
        if (!isNaN(parsed.getTime())) {
          datePosted = parsed.toISOString().split('T')[0];
        }
      } catch {
        datePosted = job.date;
      }
    }

    return new JobPostDto({
      id: null,
      title: job.title,
      companyName: job.company ?? null,
      companyUrl: null,
      jobUrl: job.url,
      jobUrlDirect: null,
      location,
      compensation,
      description,
      datePosted,
      isRemote: false,
      jobType: null,
      emails: extractEmails(description),
      companyLogo: null,
      site: Site.CAREERJET,
    });
  }
}
