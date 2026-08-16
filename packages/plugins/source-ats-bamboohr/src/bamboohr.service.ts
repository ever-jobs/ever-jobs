import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  salaryToCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  BAMBOOHR_DETAIL_CONCURRENCY,
  BAMBOOHR_HEADERS,
  bamboohrDetailUrl,
  bamboohrListUrl,
} from './bamboohr.constants';
import {
  BambooHRResponse,
  BambooHRJob,
  BambooHRJobDetail,
  BambooHRDetailResponse,
  BambooHRApiResponse,
  BambooHRApiJobOpening,
} from './bamboohr.types';

@SourcePlugin({
  site: Site.BAMBOOHR,
  name: 'BambooHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BambooHRService implements IScraper {
  private readonly logger = new Logger(BambooHRService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for BambooHR scraper');
      return new JobResponseDto([]);
    }

    // Check for API key: per-request auth overrides env var
    const apiKey = input.auth?.bamboohr?.apiKey ?? process.env.BAMBOOHR_API_KEY;
    if (apiKey) {
      try {
        const result = await this.scrapeWithApi(apiKey, companySlug, input);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `BambooHR authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BAMBOOHR_HEADERS);

    const url = bamboohrListUrl(companySlug);

    try {
      this.logger.log(`Fetching BambooHR jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: BambooHRResponse = response.data ?? { result: [] };
      const jobs = data.result ?? [];

      this.logger.log(`BambooHR: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      // The public list feed omits description/compensation/datePosted; those
      // live only on the per-job detail endpoint. Overlay the wanted slice.
      const wanted = jobs.slice(0, resultsWanted);
      const details = await this.fetchDetails(client, wanted, companySlug);

      const jobPosts: JobPostDto[] = [];
      wanted.forEach((job, index) => {
        try {
          const post = this.mapJob(
            job,
            details[index],
            companySlug,
            input.descriptionFormat,
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing BambooHR job ${job.id}: ${err.message}`);
        }
      });

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`BambooHR scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Fetch jobs using the authenticated BambooHR Job Summaries API.
   * Uses Basic Auth with the API key as username and 'x' as password.
   * Returns job openings directly (not applications), ensuring all open
   * positions are captured regardless of whether they have applications.
   *
   * @see https://documentation.bamboohr.com/reference/get-job-summaries
   */
  private async scrapeWithApi(
    apiKey: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `BambooHR: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const url = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(companySlug)}/v1/applicant_tracking/job_summaries`;
    const authToken = Buffer.from(`${apiKey}:x`).toString('base64');

    const response = await client.get<BambooHRApiResponse>(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${authToken}`,
      },
      params: {
        statusGroups: 'Open',
      },
    });

    const data = response.data ?? { jobOpenings: [] };
    const openings = data.jobOpenings ?? [];

    this.logger.log(
      `BambooHR (authenticated): found ${openings.length} job openings for ${companySlug}`,
    );

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];

    for (const opening of openings) {
      if (jobPosts.length >= resultsWanted) break;

      try {
        const post = this.mapApiJobOpening(opening, companySlug, input.descriptionFormat);
        if (post) {
          jobPosts.push(post);
        }
      } catch (err: any) {
        this.logger.warn(
          `Error processing BambooHR API job opening ${opening.id}: ${err.message}`,
        );
      }
    }

    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a BambooHR API job opening to a JobPostDto.
   */
  private mapApiJobOpening(
    opening: BambooHRApiJobOpening,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = opening.title;
    if (!title) return null;

    // Description is HTML from the API
    let description: string | null = null;
    if (opening.description) {
      if (format === DescriptionFormat.HTML) {
        description = opening.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(opening.description) ?? opening.description;
      } else {
        description = htmlToPlainText(opening.description);
      }
    }

    // Location from the job opening
    const location = new LocationDto({
      city: opening.location?.city ?? null,
      state: opening.location?.state ?? null,
      country: opening.location?.country ?? null,
    });

    // Job URL
    const jobUrl = opening.jobOpeningUrl
      ?? `https://${encodeURIComponent(companySlug)}.bamboohr.com/careers/${opening.id}`;

    return new JobPostDto({
      id: `bamboohr-${opening.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.BAMBOOHR,
      atsId: String(opening.id),
      atsType: 'bamboohr',
      department: opening.department?.label ?? null,
      datePosted: opening.dateCreated
        ? toDateOnly(opening.dateCreated)
        : null,
    });
  }

  /**
   * Overlay each listing with its per-job detail payload under bounded
   * concurrency. Fail-safe: a failed or empty detail fetch yields `null` for
   * that index (the batch is never nuked), so the job still maps from the list.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    jobs: BambooHRJob[],
    companySlug: string,
  ): Promise<(BambooHRJobDetail | null)[]> {
    const details: (BambooHRJobDetail | null)[] = new Array(jobs.length).fill(
      null,
    );
    for (
      let index = 0;
      index < jobs.length;
      index += BAMBOOHR_DETAIL_CONCURRENCY
    ) {
      const batch = jobs.slice(index, index + BAMBOOHR_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.fetchDetail(client, companySlug, job.id)),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          details[index + batchIndex] = result.value;
        }
      });
    }
    return details;
  }

  /** GET `/careers/{id}/detail` and pull out `result.jobOpening`. */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    companySlug: string,
    jobId: string | number,
  ): Promise<BambooHRJobDetail | null> {
    const response = await client.get<BambooHRDetailResponse>(
      bamboohrDetailUrl(companySlug, jobId),
    );
    return response.data?.result?.jobOpening ?? null;
  }

  private mapJob(
    job: BambooHRJob,
    detail: BambooHRJobDetail | null,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.jobOpeningName ?? detail?.jobOpeningName ?? null;
    if (!title) return null;

    const description = this.formatDescription(detail?.description, format);

    // Work mode comes from `locationType` (0 = on-site, 1 = remote, 2 = hybrid),
    // present on both list and detail. The list `isRemote` boolean is null in
    // practice, so derive remote from the work mode instead.
    const locationType = detail?.locationType ?? job.locationType ?? null;
    const workFromHomeType = this.workFromHomeTypeFromLocationType(locationType);
    const isRemote =
      String(locationType ?? '') === '1' ||
      job.isRemote === true ||
      detail?.isRemote === true;

    const location = this.buildLocation(job, detail, isRemote);

    const compensation = this.extractCompensation(detail?.compensation);

    const employmentLabel =
      job.employmentStatusLabel ?? detail?.employmentStatusLabel ?? null;
    const employmentType = employmentLabel?.trim() || null;
    const mappedJobType = employmentLabel
      ? getJobTypeFromString(employmentLabel)
      : null;

    const jobUrl =
      detail?.jobOpeningShareUrl ??
      `https://${encodeURIComponent(companySlug)}.bamboohr.com/careers/${job.id}`;

    return new JobPostDto({
      id: `bamboohr-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      ...(compensation ? { compensation } : {}),
      datePosted: detail?.datePosted ?? null,
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      ...(employmentType ? { employmentType } : {}),
      emails: extractEmails(description),
      site: Site.BAMBOOHR,
      atsId: String(job.id),
      atsType: 'bamboohr',
      department: job.departmentLabel ?? detail?.departmentLabel ?? null,
    });
  }

  /**
   * Build the location from the structured list/detail fields. BambooHR returns
   * full state names (e.g. "North Carolina") and keeps country in `atsLocation`,
   * so the pieces are mapped directly rather than routed through the shared
   * `City, ST`-oriented `parseLocationList`.
   */
  private buildLocation(
    job: BambooHRJob,
    detail: BambooHRJobDetail | null,
    isRemote: boolean,
  ): LocationDto {
    const city = job.location?.city ?? detail?.location?.city ?? null;
    const state = job.location?.state ?? detail?.location?.state ?? null;
    const country =
      detail?.atsLocation?.country ??
      job.atsLocation?.country ??
      detail?.location?.addressCountry ??
      null;

    return new LocationDto({
      city: city ?? (isRemote ? 'Remote' : null),
      state,
      country,
    });
  }

  /** Map BambooHR's `locationType` enum to a work-from-home label. */
  private workFromHomeTypeFromLocationType(
    locationType: string | number | null | undefined,
  ): string | null {
    switch (String(locationType ?? '')) {
      case '1':
        return 'Remote';
      case '2':
        return 'Hybrid';
      default:
        return null;
    }
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

  /** Parse BambooHR's free-text `compensation` into a CompensationDto. */
  private extractCompensation(
    salary: string | null | undefined,
  ): CompensationDto | null {
    return salaryToCompensation(salary);
  }
}
