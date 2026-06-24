import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  JobType,
  LocationDto,
  Site,
  DescriptionFormat,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  resolveCompensation,
  parseLocationList,
  parseJobPostingLd,
  jobPostingLdToCompensation,
  JobPostingLd,
} from '@ever-jobs/common';
import {
  WAAS_DETAIL_CONCURRENCY,
  WAAS_HEADERS,
  WAAS_MAX_RESULTS,
  waasCanonicalCompanyUrl,
  waasCompanyJobsUrl,
  waasDetailUrl,
} from './workatastartup.constants';
import {
  WaasCompany,
  WaasInertiaPage,
  WaasJobPosting,
} from './workatastartup.types';

type HttpClient = ReturnType<typeof createHttpClient>;

/** The detail-page overlay merged onto a list job. */
interface WaasDetail {
  ld: JobPostingLd | null;
  /** Markdown body from the detail `props.job.description` (ld+json fallback). */
  descriptionFallback: string | null;
}

/**
 * YC Work at a Startup (WaaS) scraper (Spec 5023).
 *
 * Harvests the public YC mirror of a WaaS company board. The company jobs page
 * embeds an Inertia.js `data-page` blob that enumerates every opening (the list
 * spine); each per-job detail page carries a schema.org `JobPosting` ld+json
 * block (the structured overlay: full description, datePosted, employmentType,
 * baseSalary, jobLocation). `companyUrl` points at the canonical
 * `workatastartup.com` board; `jobUrl` at the public YC detail page.
 */
@SourcePlugin({
  site: Site.WORKATASTARTUP,
  name: 'Work at a Startup',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkAtAStartupService implements IScraper {
  private readonly logger = new Logger(WorkAtAStartupService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Work at a Startup scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WAAS_HEADERS);

    const resultsWanted = Math.min(
      input.resultsWanted ?? 100,
      WAAS_MAX_RESULTS,
    );

    let page: WaasInertiaPage | null;
    try {
      const response = await client.get<string>(
        waasCompanyJobsUrl(companySlug),
        { responseType: 'text' },
      );
      page = this.extractInertiaPage(this.toHtml(response.data));
    } catch (err: any) {
      this.logger.error(
        `Work at a Startup scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto([]);
    }

    const company = page?.props?.company ?? null;
    const rawJobs = (page?.props?.jobPostings ?? []).filter(
      (job): job is WaasJobPosting => !!job && !!job.title,
    );
    if (rawJobs.length === 0) {
      this.logger.warn(
        `Work at a Startup: no jobPostings found for ${companySlug}`,
      );
      return new JobResponseDto([]);
    }

    const wanted = rawJobs.slice(0, resultsWanted);
    this.logger.log(
      `Work at a Startup: found ${rawJobs.length} jobs for ${companySlug}, fetching ${wanted.length} details`,
    );

    const details = await this.fetchDetails(client, wanted);

    const jobPosts: JobPostDto[] = [];
    wanted.forEach((job, i) => {
      try {
        const post = this.processJob(
          job,
          details[i],
          companySlug,
          company,
          input.descriptionFormat,
        );
        if (post) jobPosts.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Work at a Startup job ${job.id}: ${err.message}`,
        );
      }
    });

    this.logger.log(
      `Work at a Startup: mapped ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  /**
   * Pull and decode the Inertia `data-page` payload. The attribute holds the
   * page's props as an HTML-escaped JSON string. Defensive: returns null on a
   * missing attribute or malformed JSON (never throws).
   */
  private extractInertiaPage(html: string): WaasInertiaPage | null {
    if (!html) return null;
    const match = /\bdata-page="([^"]*)"/i.exec(html);
    if (!match) return null;
    try {
      return JSON.parse(this.htmlUnescape(match[1])) as WaasInertiaPage;
    } catch {
      return null;
    }
  }

  /** Decode the HTML entities Inertia uses to escape the attribute value. */
  private htmlUnescape(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** Fetch every wanted job's detail page under bounded concurrency. */
  private async fetchDetails(
    client: HttpClient,
    jobs: WaasJobPosting[],
  ): Promise<(WaasDetail | null)[]> {
    const results: (WaasDetail | null)[] = new Array(jobs.length).fill(null);
    for (let i = 0; i < jobs.length; i += WAAS_DETAIL_CONCURRENCY) {
      const batch = jobs.slice(i, i + WAAS_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.fetchDetail(client, job)),
      );
      settled.forEach((res, j) => {
        if (res.status === 'fulfilled') results[i + j] = res.value;
        else
          this.logger.warn(
            `Work at a Startup detail fetch failed for job ${batch[j].id}: ${res.reason?.message ?? res.reason}`,
          );
      });
    }
    return results;
  }

  /** Fetch and parse a single job's detail page (ld+json + markdown fallback). */
  private async fetchDetail(
    client: HttpClient,
    job: WaasJobPosting,
  ): Promise<WaasDetail | null> {
    if (!job.url) return null;
    const response = await client.get<string>(waasDetailUrl(job.url), {
      responseType: 'text',
    });
    const html = this.toHtml(response.data);
    const ld =
      parseJobPostingLd(html).find((p) => !!p.title || !!p.description) ?? null;
    const detailPage = this.extractInertiaPage(html);
    const descriptionFallback = detailPage?.props?.job?.description ?? null;
    return { ld, descriptionFallback };
  }

  private processJob(
    job: WaasJobPosting,
    detail: WaasDetail | null,
    companySlug: string,
    company: WaasCompany | null,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const ld = detail?.ld ?? null;
    const title = (ld?.title ?? job.title ?? '').trim();
    if (!title) return null;

    const description = this.resolveDescription(
      ld?.description,
      detail?.descriptionFallback,
      format,
    );
    const plainText = description ? htmlToPlainText(description) : null;

    const { location, isRemote, workFromHomeType } = this.buildLocation(
      ld,
      job.location,
    );

    const compensation = resolveCompensation({
      structured: jobPostingLdToCompensation(ld?.baseSalary),
      text: job.salaryRange ?? null,
    });
    const salarySource = ld?.baseSalary
      ? 'structured'
      : compensation
        ? 'description'
        : null;

    const jobType = this.mapJobTypes(job.type, ld?.employmentType ?? null);
    const datePosted = ld?.datePosted ? this.toDateOnly(ld.datePosted) : null;
    const jobUrl = job.url
      ? waasDetailUrl(job.url)
      : waasCanonicalCompanyUrl(companySlug);

    return new JobPostDto({
      id: job.id != null ? `workatastartup-${job.id}` : undefined,
      title,
      companyName: company?.name ?? job.companyName ?? null,
      jobUrl,
      companyUrl: waasCanonicalCompanyUrl(companySlug),
      ...(job.applyUrl ? { applyUrl: job.applyUrl } : {}),
      location,
      description,
      ...(isRemote ? { isRemote: true } : {}),
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(jobType.length > 0 ? { jobType } : {}),
      ...(ld?.employmentType ? { employmentType: ld.employmentType } : {}),
      ...(compensation ? { compensation, salarySource } : {}),
      ...(job.prettyRole ? { jobFunction: job.prettyRole } : {}),
      ...(job.skills && job.skills.length > 0 ? { skills: job.skills } : {}),
      ...(job.minExperience ? { experienceRange: job.minExperience } : {}),
      ...(datePosted ? { datePosted } : {}),
      emails: extractEmails(plainText),
      site: Site.WORKATASTARTUP,
      atsId: job.id != null ? String(job.id) : null,
      atsType: 'workatastartup',
    });
  }

  /**
   * Build the location from the ld+json structured `jobLocation` (multi-site →
   * semicolon-joined), falling back to the list `location` text (` / `
   * delimited). Remote / hybrid intent comes from the same parse plus the
   * ld+json `TELECOMMUTE` flag.
   */
  private buildLocation(
    ld: JobPostingLd | null,
    listLocation: string | null | undefined,
  ): {
    location: LocationDto | null;
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    const ldLabels = (ld?.locations ?? [])
      .map((loc) => loc.label)
      .filter((label): label is string => !!label && label.trim().length > 0);
    const labels =
      ldLabels.length > 0
        ? ldLabels
        : (listLocation ?? '')
            .split('/')
            .map((part) => part.trim())
            .filter((part) => part.length > 0);

    const parsed = parseLocationList(labels);
    const isRemote = parsed.remoteMentioned || !!ld?.remote;
    return {
      location: parsed.location,
      isRemote,
      workFromHomeType: parsed.workFromHomeType,
    };
  }

  /**
   * Map the list `type` (e.g. `Full-time`) to a {@link JobType}, falling back to
   * the ld+json `employmentType` (e.g. `FULL_TIME`, possibly `, `-joined).
   */
  private mapJobTypes(
    listType: string | null | undefined,
    employmentType: string | null,
  ): JobType[] {
    const seen = new Set<JobType>();
    const fromList = listType ? getJobTypeFromString(listType) : null;
    if (fromList) seen.add(fromList);
    if (employmentType) {
      for (const token of employmentType.split(',')) {
        const mapped = getJobTypeFromString(token.replace(/_/g, ''));
        if (mapped) seen.add(mapped);
      }
    }
    return [...seen];
  }

  private resolveDescription(
    ldHtml: string | null | undefined,
    markdownFallback: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (ldHtml && ldHtml.trim()) return this.formatHtml(ldHtml, format);
    if (markdownFallback && markdownFallback.trim()) {
      return this.formatMarkdown(markdownFallback, format);
    }
    return null;
  }

  private formatHtml(
    html: string,
    format?: DescriptionFormat,
  ): string | null {
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }

  private formatMarkdown(
    markdown: string,
    format?: DescriptionFormat,
  ): string | null {
    if (format === DescriptionFormat.MARKDOWN) return markdown;
    // The fallback body is markdown; for HTML/plain callers, plain text is the
    // safe lossless-enough rendering (no markdown→HTML lib in the hot path).
    return htmlToPlainText(markdown);
  }

  private toDateOnly(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toISOString().split('T')[0];
  }

  private toHtml(data: unknown): string {
    return typeof data === 'string' ? data : '';
  }
}
