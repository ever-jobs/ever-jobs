import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  WORKABLE_API_URL,
  WORKABLE_DETAIL_CONCURRENCY,
  WORKABLE_HEADERS,
  workableDetailUrl,
} from './workable.constants';
import {
  WorkableJob,
  WorkableJobDetail,
  WorkableResponse,
  WorkableApiV3Job,
  WorkableApiV3Response,
} from './workable.types';

@SourcePlugin({
  site: Site.WORKABLE,
  name: 'Workable',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkableService implements IScraper {
  private readonly logger = new Logger(WorkableService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Workable scraper');
      return new JobResponseDto([]);
    }

    // Check for API token: per-request auth overrides env var
    const accessToken =
      input.auth?.workable?.accessToken ?? process.env.WORKABLE_API_TOKEN;
    const subdomain =
      input.auth?.workable?.subdomain ??
      process.env.WORKABLE_SUBDOMAIN ??
      companySlug;

    if (accessToken) {
      try {
        const result = await this.scrapeWithApi(
          accessToken,
          subdomain,
          companySlug,
          input,
        );
        return result;
      } catch (err: any) {
        this.logger.warn(
          `Workable authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WORKABLE_HEADERS);

    const url = `${WORKABLE_API_URL}/${encodeURIComponent(companySlug)}`;

    try {
      this.logger.log(`Fetching Workable jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: WorkableResponse = response.data ?? { jobs: [] };
      const jobs = data.jobs ?? [];

      // The widget response carries the display name at the top-level `name`;
      // the slug is not the company name.
      const companyName = data.name?.trim() || companySlug;

      this.logger.log(`Workable: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const limited = jobs.slice(0, resultsWanted);

      // The widget list omits description and work-mode; overlay each job with
      // its public v2 detail (rich body + workplace) before mapping.
      const details = await this.fetchDetails(client, limited, companySlug);

      const jobPosts: JobPostDto[] = [];
      limited.forEach((job, index) => {
        try {
          const post = this.processJob(
            job,
            companySlug,
            companyName,
            input.descriptionFormat,
            details[index],
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Workable job ${job.shortcode}: ${err.message}`);
        }
      });

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Workable scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Fetch jobs using the authenticated Workable API v3.
   * Uses Bearer token auth and returns published jobs.
   * @see https://workable.readme.io/reference/jobs
   */
  private async scrapeWithApi(
    accessToken: string,
    subdomain: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `Workable: using authenticated API v3 for subdomain: ${subdomain}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const limit = Math.min(resultsWanted, 100);
    const baseUrl = `https://${encodeURIComponent(subdomain)}.workable.com/spi/v3/jobs`;
    const jobPosts: JobPostDto[] = [];
    let sinceId: string | null = null;

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };

    while (jobPosts.length < resultsWanted) {
      let url = `${baseUrl}?state=published&limit=${limit}`;
      if (sinceId) {
        url += `&since_id=${encodeURIComponent(sinceId)}`;
      }

      const response = await client.get<WorkableApiV3Response>(url, { headers });

      const data = response.data ?? { jobs: [] };
      const jobs = data.jobs ?? [];

      if (jobs.length === 0) break;

      this.logger.log(
        `Workable (authenticated): fetched ${jobs.length} jobs for ${subdomain}`,
      );

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processApiJob(job, companySlug);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Workable API job ${job.shortcode}: ${err.message}`,
          );
        }
      }

      // Workable API uses cursor-based pagination via paging.next
      sinceId = data.paging?.next ?? null;
      if (!sinceId) break;
    }

    this.logger.log(
      `Workable (authenticated) total: ${jobPosts.length} jobs for ${subdomain}`,
    );
    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a Workable API v3 job to JobPostDto.
   */
  private processApiJob(
    job: WorkableApiV3Job,
    companySlug: string,
  ): JobPostDto | null {
    const title = job.full_title ?? job.title;
    if (!title) return null;

    const loc = job.location;
    const location = new LocationDto({
      city: loc?.city ?? null,
      state: loc?.region ?? null,
      country: loc?.country ?? null,
    });

    const isRemote = loc?.telecommuting ?? false;

    const jobType = job.employment_type
      ? (() => {
          const mapped = getJobTypeFromString(job.employment_type!);
          return mapped ? [mapped] : null;
        })()
      : null;

    const datePosted = job.published_on ?? job.created_at ?? null;

    return new JobPostDto({
      id: `workable-${job.shortcode ?? job.id}`,
      title,
      companyName: companySlug,
      jobUrl:
        job.url ??
        job.shortlink ??
        `https://apply.workable.com/${companySlug}/j/${job.shortcode}`,
      location,
      datePosted: datePosted
        ? toDateOnly(datePosted)
        : null,
      isRemote,
      jobType,
      site: Site.WORKABLE,
      // ATS-specific fields
      atsId: job.shortcode ?? job.id ?? null,
      atsType: 'workable',
      department: job.department ?? null,
      employmentType: job.employment_type ?? null,
      applyUrl: job.application_url ?? null,
    });
  }

  private processJob(
    job: WorkableJob,
    companySlug: string,
    companyName: string,
    format?: DescriptionFormat,
    detail?: WorkableJobDetail | null,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Location
    const primaryLoc = job.locations?.[0];
    const location = new LocationDto({
      city: primaryLoc?.city ?? job.city ?? null,
      state: primaryLoc?.region ?? job.state ?? null,
      country: primaryLoc?.country ?? job.country ?? null,
    });

    // Remote detection: widget telecommuting OR the detail's work-mode signals.
    const isRemote =
      (job.telecommuting ?? false) ||
      (detail?.remote ?? false) ||
      detail?.workplace?.toLowerCase() === 'remote';

    // Job type
    const jobType = job.employment_type
      ? (() => {
          const mapped = getJobTypeFromString(job.employment_type!);
          return mapped ? [mapped] : null;
        })()
      : null;

    // Date
    const datePosted = job.published_on ?? job.created_at ?? null;

    const description = this.formatDescription(detail, format);
    const workFromHomeType = this.workFromHomeTypeFromWorkplace(detail?.workplace);

    // Workable exposes no structured compensation, so parse the plain-text
    // body for a stated salary range (Spec 5018).
    const compensation = resolveCompensation({
      text: this.formatDescription(detail, DescriptionFormat.PLAIN),
    });

    return new JobPostDto({
      id: `workable-${job.shortcode}`,
      title,
      companyName,
      jobUrl: job.url ?? job.shortlink ?? `https://apply.workable.com/${companySlug}/j/${job.shortcode}`,
      location,
      description,
      ...(compensation ? { compensation } : {}),
      datePosted: datePosted
        ? toDateOnly(datePosted)
        : null,
      isRemote,
      jobType,
      jobFunction: job.function ?? null,
      site: Site.WORKABLE,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      // ATS-specific fields
      atsId: job.shortcode ?? null,
      atsType: 'workable',
      department: job.department ?? null,
      employmentType: job.employment_type ?? null,
      applyUrl: job.application_url ?? null,
    });
  }

  /**
   * Fetch the public v2 detail for each job under bounded concurrency.
   * Returns details aligned by index; a failed/empty fetch yields null so the
   * job still maps from the widget list.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    jobs: WorkableJob[],
    companySlug: string,
  ): Promise<(WorkableJobDetail | null)[]> {
    const details: (WorkableJobDetail | null)[] = new Array(jobs.length).fill(
      null,
    );

    for (
      let index = 0;
      index < jobs.length;
      index += WORKABLE_DETAIL_CONCURRENCY
    ) {
      const batch = jobs.slice(index, index + WORKABLE_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.fetchDetail(client, job, companySlug)),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          details[index + batchIndex] = result.value;
        }
      });
    }

    return details;
  }

  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    job: WorkableJob,
    companySlug: string,
  ): Promise<WorkableJobDetail | null> {
    const shortcode = job.shortcode;
    if (!shortcode) return null;

    try {
      const response = await client.get<WorkableJobDetail>(
        workableDetailUrl(companySlug, shortcode),
      );
      return response.data ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Workable: detail fetch failed for ${companySlug}/${shortcode}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Build the posting body by concatenating the detail's description,
   * requirements, and benefits (Workable splits them), then render to the
   * requested format. Markdown is the default.
   */
  private formatDescription(
    detail: WorkableJobDetail | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!detail) return null;
    const html = [detail.description, detail.requirements, detail.benefits]
      .filter(
        (part): part is string =>
          typeof part === 'string' && part.trim().length > 0,
      )
      .map((part) => part.trim())
      .join('\n');
    if (!html) return null;

    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.PLAIN) return htmlToPlainText(html);
    return markdownConverter(html) ?? html;
  }

  /** Map the Workable `workplace` enum to a workFromHomeType label. on_site → none. */
  private workFromHomeTypeFromWorkplace(
    workplace?: string | null,
  ): string | null {
    switch (workplace?.toLowerCase()) {
      case 'hybrid':
        return 'Hybrid';
      case 'remote':
        return 'Remote';
      default:
        return null;
    }
  }
}
