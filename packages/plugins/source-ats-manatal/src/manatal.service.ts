import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import { classifyScrapeError,
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
  resolveCompensation,
  parseLocationText,
} from '@ever-jobs/common';
import {
  MANATAL_HEADERS,
  MANATAL_MAX_PAGES,
  manatalCompanyUrl,
  manatalJobUrl,
  manatalListUrl,
} from './manatal.constants';
import { ManatalJob, ManatalResponse } from './manatal.types';

type HttpClient = ReturnType<typeof createHttpClient>;

/** Amount thresholds (USD-scale) used to infer a missing pay interval. */
const HOURLY_CEILING = 350;
const MONTHLY_CEILING = 30000;

@SourcePlugin({
  site: Site.MANATAL,
  name: 'Manatal',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ManatalService implements IScraper {
  private readonly logger = new Logger(ManatalService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Manatal scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(MANATAL_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;

    let rawJobs: ManatalJob[];
    try {
      rawJobs = await this.fetchAllJobs(client, companySlug, resultsWanted);
    } catch (err: any) {
      this.logger.error(
        `Manatal scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    }

    this.logger.log(
      `Manatal: found ${rawJobs.length} raw jobs for ${companySlug}`,
    );

    const jobPosts: JobPostDto[] = [];
    for (const job of rawJobs) {
      if (jobPosts.length >= resultsWanted) break;
      try {
        const post = this.processJob(
          job,
          companySlug,
          input.descriptionFormat,
        );
        if (post) jobPosts.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Manatal job ${job.id}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Manatal: mapped ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  /**
   * Follow the careers-page.com pagination chain. The list response is
   * self-contained (full description, structured location, salary when
   * visible), so no per-job detail fetch is needed. Stops once enough jobs are
   * gathered, the `next` link is exhausted, or the page cap is hit.
   */
  private async fetchAllJobs(
    client: HttpClient,
    slug: string,
    resultsWanted: number,
  ): Promise<ManatalJob[]> {
    const jobs: ManatalJob[] = [];
    let url: string | null = manatalListUrl(slug);

    for (let page = 0; url && page < MANATAL_MAX_PAGES; page++) {
      this.logger.log(`Fetching Manatal jobs for ${slug} (page ${page + 1})`);
      const response = await client.get(url);
      const data = (response.data ?? {}) as ManatalResponse;
      const pageJobs = data.results ?? [];
      jobs.push(...pageJobs);
      if (jobs.length >= resultsWanted) break;
      url = data.next ?? null;
    }

    return jobs;
  }

  private processJob(
    job: ManatalJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.position_name?.trim();
    if (!title) return null;

    const description = this.formatDescription(job.description, format);
    const plainText = job.description
      ? htmlToPlainText(job.description)
      : null;

    const { location, isRemote, workFromHomeType } = this.buildLocation(job);

    const structured = this.structuredCompensation(job);
    const compensation = resolveCompensation({ structured, text: plainText });
    const salarySource = structured
      ? 'structured'
      : compensation
        ? 'description'
        : null;

    return new JobPostDto({
      id: `manatal-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl: manatalJobUrl(companySlug, job.hash),
      companyUrl: manatalCompanyUrl(companySlug),
      location,
      description,
      ...(isRemote ? { isRemote: true } : {}),
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(compensation ? { compensation, salarySource } : {}),
      emails: extractEmails(plainText),
      site: Site.MANATAL,
      atsId: String(job.id),
      atsType: 'manatal',
    });
  }

  /**
   * Build the location from the structured city/state/country fields, falling
   * back to parsing `location_display` when they are absent. Remote / hybrid
   * intent is inferred from the location text (the API exposes no remote flag).
   */
  private buildLocation(job: ManatalJob): {
    location: LocationDto | null;
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    const city = job.city?.trim() || null;
    const state = job.state?.trim() || null;
    const country = job.country?.trim() || null;

    const parsedText = parseLocationText(job.location_display);
    const isRemote = parsedText.remoteMentioned;
    const workFromHomeType = parsedText.workFromHomeType;

    let location: LocationDto | null;
    if (city || state || country) {
      location = new LocationDto({ city, state, country });
    } else {
      location = parsedText.location;
    }

    return { location, isRemote, workFromHomeType };
  }

  /**
   * Map the structured salary fields to a {@link CompensationDto}. The API
   * omits the pay interval, so it is inferred from the amount magnitude using
   * the same thresholds as the shared text parser (hourly < 350, monthly <
   * 30000, else yearly). Returns null when salary is not visible or unbounded.
   */
  private structuredCompensation(job: ManatalJob): CompensationDto | null {
    if (!job.is_salary_visible) return null;

    const min = this.toAmount(job.salary_min);
    const max = this.toAmount(job.salary_max);
    if (min == null && max == null) return null;

    const basis = min ?? max ?? 0;
    const interval =
      basis < HOURLY_CEILING
        ? CompensationInterval.HOURLY
        : basis < MONTHLY_CEILING
          ? CompensationInterval.MONTHLY
          : CompensationInterval.YEARLY;

    return new CompensationDto({
      interval,
      minAmount: min ?? undefined,
      maxAmount: max ?? undefined,
      currency: job.currency_code ?? 'USD',
    });
  }

  /** Parse a careers-page.com decimal-string (or number) salary value. */
  private toAmount(value: number | string | null | undefined): number | null {
    if (value == null) return null;
    const num = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  private formatDescription(
    html: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!html || !html.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }
}
