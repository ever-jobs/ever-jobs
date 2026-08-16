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
  jobPostingLdToCompensation,
  parseJobPostingLd,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  PAYLOCITY_DETAIL_CONCURRENCY,
  PAYLOCITY_HEADERS,
  paylocityBoardUrl,
  paylocityDetailUrl,
} from './paylocity.constants';
import {
  PaylocityPageData,
  PaylocityListJob,
  PaylocityJobDetail,
} from './paylocity.types';

type HttpClient = ReturnType<typeof createHttpClient>;

@SourcePlugin({
  site: Site.PAYLOCITY,
  name: 'Paylocity',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PaylocityService implements IScraper {
  private readonly logger = new Logger(PaylocityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    // `companySlug` is the company GUID from the careers-page board link.
    const guid = input.companySlug;
    if (!guid) {
      this.logger.warn('No companySlug provided for Paylocity scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PAYLOCITY_HEADERS);

    let pageData: PaylocityPageData | null;
    try {
      this.logger.log(`Fetching Paylocity board for company: ${guid}`);
      const response = await client.get(paylocityBoardUrl(guid));
      pageData = this.parsePageData(this.toHtml(response.data));
    } catch (err: any) {
      this.logger.error(`Paylocity board fetch error for ${guid}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }

    const jobs = pageData?.Jobs ?? [];
    if (jobs.length === 0) {
      this.logger.warn(`Paylocity: no jobs found on board for ${guid}`);
      return new JobResponseDto([]);
    }

    const companyName = this.cleanCompanyName(pageData?.ModuleTitle) || guid;
    const resultsWanted = input.resultsWanted ?? 100;
    const wanted = jobs.slice(0, resultsWanted);

    // Overlay each job with its detail page (full description + Job Type).
    const details = await this.fetchDetails(client, wanted, guid);

    const jobPosts: JobPostDto[] = [];
    wanted.forEach((job, i) => {
      try {
        const post = this.processJob(
          job,
          details[i],
          guid,
          companyName,
          input.descriptionFormat,
        );
        if (post) jobPosts.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Paylocity job ${job.JobId}: ${err.message}`,
        );
      }
    });

    this.logger.log(`Paylocity: mapped ${jobPosts.length} jobs for ${guid}`);
    return new JobResponseDto(jobPosts);
  }

  /** Coerce the HTTP client's response body to an HTML string. */
  private toHtml(data: unknown): string {
    return typeof data === 'string' ? data : String(data ?? '');
  }

  /**
   * Extract `window.pageData` from the board HTML. Uses a string-aware brace
   * matcher (descriptions/values can contain `{`/`}`), then `JSON.parse`.
   */
  private parsePageData(html: string): PaylocityPageData | null {
    const marker = html.indexOf('window.pageData');
    if (marker === -1) return null;
    const start = html.indexOf('{', marker);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1)) as PaylocityPageData;
          } catch (err: any) {
            this.logger.warn(`Failed to parse Paylocity pageData: ${err.message}`);
            return null;
          }
        }
      }
    }
    return null;
  }

  /** Fetch every wanted job's detail page under bounded concurrency. */
  private async fetchDetails(
    client: HttpClient,
    jobs: PaylocityListJob[],
    guid: string,
  ): Promise<(PaylocityJobDetail | null)[]> {
    const results: (PaylocityJobDetail | null)[] = new Array(jobs.length).fill(
      null,
    );
    for (let i = 0; i < jobs.length; i += PAYLOCITY_DETAIL_CONCURRENCY) {
      const batch = jobs.slice(i, i + PAYLOCITY_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.fetchDetail(client, guid, job.JobId)),
      );
      settled.forEach((res, j) => {
        if (res.status === 'fulfilled') results[i + j] = res.value;
        else
          this.logger.warn(
            `Paylocity detail fetch failed for job ${batch[j].JobId}: ${res.reason?.message ?? res.reason}`,
          );
      });
    }
    return results;
  }

  /** Fetch and parse a single job's detail page. */
  private async fetchDetail(
    client: HttpClient,
    guid: string,
    jobId: string | number,
  ): Promise<PaylocityJobDetail | null> {
    const response = await client.get(paylocityDetailUrl(guid, jobId));
    return this.parseDetail(this.toHtml(response.data));
  }

  /**
   * Parse a job's detail page.
   *
   * Description is the **full visible body**: every `job-listing-header`
   * section (Description, Salary Description, Requirements, …) concatenated.
   * The embedded schema.org `JobPosting.description` carries only the
   * "Description" section, so it is used solely as a fallback when the HTML
   * sections cannot be parsed — preferring it would silently drop every other
   * visible section. `Job Type` only ever appears in the HTML header sections
   * (the ld+json omits `employmentType`), so it is always parsed from HTML.
   *
   * Structured pay is read from the ld+json `baseSalary` (the robust,
   * format-independent source) for compensation resolution downstream.
   */
  private parseDetail(html: string): PaylocityJobDetail {
    const htmlParsed = this.parseDetailHtml(html);
    const postings = parseJobPostingLd(html);

    const ldDescription = postings
      .map((p) => p.description)
      .find((d): d is string => !!d && d.trim().length > 0);
    const baseSalary = postings.map((p) => p.baseSalary).find((s) => !!s);

    return {
      description: htmlParsed.description ?? ldDescription ?? null,
      jobType: htmlParsed.jobType,
      baseSalary: baseSalary ?? null,
    };
  }

  /**
   * Parse the detail page's `job-listing-header` sections. `Job Type` becomes
   * the employment type; every other section (Description, Requirements, …) is
   * concatenated into the description body.
   */
  private parseDetailHtml(
    html: string,
  ): Pick<PaylocityJobDetail, 'description' | 'jobType'> {
    let jobType: string | null = null;
    const parts: string[] = [];

    const headerRe = /<div class="job-listing-header">([^<]*)<\/div>/g;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(html)) !== null) {
      const label = this.decodeEntities(match[1].trim());
      const value = this.captureFollowingDiv(html, headerRe.lastIndex);
      if (!value) continue;
      if (label.toLowerCase() === 'job type') {
        jobType = htmlToPlainText(value)?.trim() || null;
      } else if (label.toLowerCase() === 'description') {
        parts.push(value);
      } else {
        parts.push(`<h3>${label}</h3>${value}`);
      }
    }

    const description = parts.length > 0 ? parts.join('\n') : null;
    return { description, jobType };
  }

  /**
   * From `fromIndex`, skip whitespace to the next `<div ...>` and return its
   * inner HTML with balanced nesting.
   */
  private captureFollowingDiv(html: string, fromIndex: number): string | null {
    const open = html.indexOf('<div', fromIndex);
    if (open === -1) return null;
    const contentStart = html.indexOf('>', open);
    if (contentStart === -1) return null;
    // Bail if anything other than whitespace separates header and this div.
    if (html.slice(fromIndex, open).trim() !== '') return null;

    let depth = 1;
    let i = contentStart + 1;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      if (nextClose === -1) return null;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) return html.slice(contentStart + 1, nextClose);
        i = nextClose + 6;
      }
    }
    return null;
  }

  private decodeEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  /**
   * `ModuleTitle` is the company display name with the Paylocity module id
   * appended in brackets, e.g. `"SendCutSend Inc [175255]"`. The bracketed id
   * is not part of the company name, so strip a trailing ` [\d+]`.
   */
  private cleanCompanyName(title: string | null | undefined): string | null {
    const trimmed = title?.trim();
    if (!trimmed) return null;
    return trimmed.replace(/\s*\[\d+\]\s*$/, '').trim() || null;
  }

  private processJob(
    job: PaylocityListJob,
    detail: PaylocityJobDetail | null,
    guid: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.JobTitle;
    if (!title) return null;

    const description = this.formatDescription(detail?.description, format);

    const isRemote = job.IsRemote === true || job.IndeedRemoteType === 1;
    const workFromHomeType = this.workFromHomeType(job, isRemote);
    const location = this.buildLocation(job, isRemote);

    const compensation: CompensationDto | null = resolveCompensation({
      structured: jobPostingLdToCompensation(detail?.baseSalary),
      text: description,
    });
    const salarySource = detail?.baseSalary
      ? 'structured'
      : compensation
        ? 'description'
        : null;

    const mappedJobType = detail?.jobType
      ? getJobTypeFromString(detail.jobType)
      : null;

    const datePosted = job.PublishedDate
      ? toDateOnly(job.PublishedDate)
      : null;

    return new JobPostDto({
      id: `paylocity-${job.JobId}`,
      title,
      companyName,
      jobUrl: paylocityDetailUrl(guid, job.JobId),
      location,
      description,
      datePosted,
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      ...(detail?.jobType ? { employmentType: detail.jobType } : {}),
      ...(compensation ? { compensation, salarySource } : {}),
      emails: extractEmails(description),
      site: Site.PAYLOCITY,
      atsId: String(job.JobId),
      atsType: 'paylocity',
      department: job.HiringDepartment ?? null,
    });
  }

  private buildLocation(job: PaylocityListJob, isRemote: boolean): LocationDto {
    const loc = job.JobLocation ?? null;
    const city = loc?.City?.trim() || null;
    const state = loc?.State?.trim() || null;
    const country = loc?.Country?.trim() || null;
    return new LocationDto({
      city: city ?? (isRemote ? 'Remote' : null),
      state,
      country,
    });
  }

  /** Remote → `Remote`; an explicit hybrid hint in the location text → `Hybrid`. */
  private workFromHomeType(
    job: PaylocityListJob,
    isRemote: boolean,
  ): string | null {
    if (isRemote) return 'Remote';
    const text = `${job.LocationName ?? ''} ${job.JobLocation?.Name ?? ''}`.toLowerCase();
    if (text.includes('hybrid')) return 'Hybrid';
    return null;
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
