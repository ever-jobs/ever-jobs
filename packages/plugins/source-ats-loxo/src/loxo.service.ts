import { SourcePlugin } from '@ever-jobs/plugin';

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
  toDateOnly,
} from '@ever-jobs/common';
import { LOXO_API_URL, LOXO_HEADERS } from './loxo.constants';
import { LoxoJob, LoxoJobLocation, LoxoCompensation } from './loxo.types';

@SourcePlugin({
  site: Site.LOXO,
  name: 'Loxo',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class LoxoService implements IScraper {
  private readonly logger = new Logger(LoxoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Loxo scraper');
      return new JobResponseDto([]);
    }

    // ─── Resolve API token: per-request auth overrides env var ────
    const apiToken =
      input.auth?.loxo?.apiToken ?? process.env.LOXO_API_TOKEN ?? null;

    // ─── Try public endpoint first ───────────────────────────────
    try {
      const result = await this.fetchJobs(input, companySlug, null);
      if (result.jobs.length > 0) {
        return result;
      }
    } catch (err: any) {
      this.logger.warn(
        `Loxo public endpoint failed for ${companySlug}: ${err.message}`,
      );
    }

    // ─── Fall back to authenticated API if token is available ────
    if (apiToken) {
      try {
        return await this.fetchJobs(input, companySlug, apiToken);
      } catch (err: any) {
        this.logger.error(
          `Loxo authenticated API also failed for ${companySlug}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto([]);
  }

  /**
   * Fetch jobs from the Loxo API.
   * When `apiToken` is provided, includes an `Authorization: Bearer` header.
   */
  private async fetchJobs(
    input: ScraperInputDto,
    companySlug: string,
    apiToken: string | null,
  ): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const headers: Record<string, string> = { ...LOXO_HEADERS };
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`;
    }
    client.setHeaders(headers);

    const url = `${LOXO_API_URL}/${encodeURIComponent(companySlug)}/jobs`;
    const mode = apiToken ? 'authenticated' : 'public';

    this.logger.log(
      `Fetching Loxo jobs (${mode}) for company: ${companySlug}`,
    );

    const response = await client.get(url);
    const raw = response.data;

    // The API may return an array directly or an object with a jobs key
    const jobs: LoxoJob[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.jobs)
        ? raw.jobs
        : [];

    if (jobs.length === 0) {
      this.logger.log(`Loxo (${mode}): no jobs found for ${companySlug}`);
      return new JobResponseDto([]);
    }

    this.logger.log(
      `Loxo (${mode}): found ${jobs.length} raw jobs for ${companySlug}`,
    );

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];

    for (const job of jobs) {
      if (jobPosts.length >= resultsWanted) break;

      try {
        const post = this.processJob(
          job,
          companySlug,
          input.descriptionFormat,
        );
        if (post) {
          jobPosts.push(post);
        }
      } catch (err: any) {
        this.logger.warn(
          `Error processing Loxo job ${job.id}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a Loxo API job object to a JobPostDto.
   */
  private processJob(
    job: LoxoJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // ─── Description handling ────────────────────────────────────
    let description: string | null = null;
    const rawDescription = job.description ?? null;

    if (rawDescription) {
      switch (format) {
        case DescriptionFormat.HTML:
          description = rawDescription;
          break;
        case DescriptionFormat.PLAIN:
          description = htmlToPlainText(rawDescription);
          break;
        case DescriptionFormat.MARKDOWN:
        default:
          description = markdownConverter(rawDescription) ?? htmlToPlainText(rawDescription);
          break;
      }
    }

    // ─── Location parsing ────────────────────────────────────────
    const location = this.parseLocation(job.location);

    // ─── Remote detection ────────────────────────────────────────
    const locationStr =
      typeof job.location === 'string' ? job.location : null;
    const isRemote =
      job.remote === true ||
      locationStr?.toLowerCase().includes('remote') ||
      title.toLowerCase().includes('remote') ||
      false;

    // ─── Compensation parsing ────────────────────────────────────
    const compensation = this.parseCompensation(
      job.salary ?? job.compensation ?? null,
    );

    // ─── Job URL ─────────────────────────────────────────────────
    const jobUrl =
      job.url ??
      job.apply_url ??
      `${LOXO_API_URL}/${encodeURIComponent(companySlug)}/jobs/${job.id}`;

    return new JobPostDto({
      id: `loxo-${job.id}`,
      title,
      companyName: job.company_name ?? companySlug,
      jobUrl,
      location,
      description,
      datePosted: job.created_at
        ? toDateOnly(job.created_at)
        : null,
      isRemote,
      compensation,
      emails: extractEmails(description),
      site: Site.LOXO,
      // ATS-specific fields
      atsId: job.id != null ? String(job.id) : null,
      atsType: 'loxo',
      department: job.department ?? job.category ?? null,
      employmentType: job.employment_type ?? job.type ?? null,
      applyUrl: job.apply_url ?? null,
    });
  }

  /**
   * Parse the Loxo location field, which can be a string or a structured object.
   */
  private parseLocation(
    raw: string | LoxoJobLocation | null | undefined,
  ): LocationDto | null {
    if (!raw) return null;

    if (typeof raw === 'string') {
      return new LocationDto({ city: raw });
    }

    // Structured location object
    const parts: string[] = [];
    if (raw.city) parts.push(raw.city);
    if (raw.state) parts.push(raw.state);
    if (raw.country) parts.push(raw.country);

    if (parts.length === 0) return null;

    return new LocationDto({
      city: raw.city ?? null,
      state: raw.state ?? null,
      country: raw.country ?? null,
    });
  }

  /**
   * Parse compensation/salary from the Loxo response.
   */
  private parseCompensation(
    raw: LoxoCompensation | null | undefined,
  ): CompensationDto | null {
    if (!raw) return null;
    if (raw.min == null && raw.max == null) return null;

    let interval: CompensationInterval | null = null;
    if (raw.interval) {
      const upper = raw.interval.toUpperCase();
      if (upper.includes('YEAR') || upper.includes('ANNUAL')) {
        interval = CompensationInterval.YEARLY;
      } else if (upper.includes('MONTH')) {
        interval = CompensationInterval.MONTHLY;
      } else if (upper.includes('WEEK')) {
        interval = CompensationInterval.WEEKLY;
      } else if (upper.includes('DAY')) {
        interval = CompensationInterval.DAILY;
      } else if (upper.includes('HOUR')) {
        interval = CompensationInterval.HOURLY;
      }
    }

    return new CompensationDto({
      minAmount: raw.min ?? null,
      maxAmount: raw.max ?? null,
      currency: raw.currency ?? 'USD',
      interval,
    });
  }
}
