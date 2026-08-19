import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
} from '@ever-jobs/common';
import {
  RECRUITCRM_ALBATROSS_BASE,
  RECRUITCRM_JOBS_PATH_TEMPLATE,
  RECRUITCRM_JOB_DETAIL_TEMPLATE,
  RECRUITCRM_ORIGIN,
  RECRUITCRM_JOBS_PAGE_BASE,
  RECRUITCRM_PAGE_SIZE,
  RECRUITCRM_MAX_CONCURRENCY,
  RECRUITCRM_REQUEST_DELAY_MS,
  RECRUITCRM_DEFAULT_RESULTS,
  RECRUITCRM_HEADERS,
} from './recruitcrm.constants';
import { RecruitCrmJob, RecruitCrmJobsResponse } from './recruitcrm.types';

/**
 * Recruit CRM public career-page scraper — generic, multi-tenant.
 *
 * Recruit CRM is a recruiting-agency CRM and ATS.  Each agency publishes a
 * public jobs page at `https://recruitcrm.io/jobs/{accountSlug}`.  The SPA
 * powering that page calls a public, anonymous endpoint on the Albatross
 * backend:
 *
 *   POST https://albatross.recruitcrm.io/v1/external-pages/jobs-by-account/get
 *        ?account={accountSlug}&batch=true
 *
 * The endpoint returns `{ data: { jobs: [...] } }` with the full job objects
 * (including `jdtext` — the HTML description) in a single call.  We page it
 * with a bounded concurrent fan-out until fewer rows than `limit` are returned,
 * which signals all open roles have been exhausted.
 *
 * The account slug is taken from `companySlug` or derived from the path segment
 * of `companyUrl` (the last non-empty path component, e.g. `Terra_Careers` from
 * `https://recruitcrm.io/jobs/Terra_Careers`).  A single fetch error, unknown
 * tenant (HTTP 400/404, or `status: "fail"`), or malformed payload degrades to
 * an empty/partial result rather than throwing, so a single tenant never nukes
 * a batch run.  No credentials or API keys are required.
 */
@SourcePlugin({
  site: Site.RECRUITCRM,
  name: 'Recruit CRM',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecruitCrmService implements IScraper {
  private readonly logger = new Logger(RecruitCrmService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Recruit CRM scraper');
      return new JobResponseDto([]);
    }

    const accountSlug = this.resolveAccountSlug(companySlug, input.companyUrl);
    if (!accountSlug) {
      this.logger.warn('Could not resolve a Recruit CRM account slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...RECRUITCRM_HEADERS,
      Origin: RECRUITCRM_ORIGIN,
      Referer: `${RECRUITCRM_JOBS_PAGE_BASE}/${encodeURIComponent(accountSlug)}`,
    });

    const resultsWanted = input.resultsWanted ?? RECRUITCRM_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Recruit CRM jobs for account: ${accountSlug}`);

      // First page → jobs; when returned count < limit the feed is exhausted.
      const first = await this.fetchPage(client, accountSlug, 0);
      this.collect(first, accountSlug, input.descriptionFormat, seen, jobPosts);

      if (jobPosts.length < resultsWanted && first.length === RECRUITCRM_PAGE_SIZE) {
        const offsets: number[] = [];
        for (
          let offset = RECRUITCRM_PAGE_SIZE;
          jobPosts.length + offsets.length * RECRUITCRM_PAGE_SIZE < resultsWanted;
          offset += RECRUITCRM_PAGE_SIZE
        ) {
          offsets.push(offset);
          // Avoid unbounded loops: stop scheduling more pages once we have enough
          // already queued to satisfy resultsWanted.
          if (jobPosts.length + offsets.length * RECRUITCRM_PAGE_SIZE >= resultsWanted) break;
          if (offsets.length > 20) break; // hard guard
        }

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < offsets.length; i += RECRUITCRM_MAX_CONCURRENCY) {
          const chunk = offsets.slice(i, i + RECRUITCRM_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((offset) => this.fetchPage(client, accountSlug, offset)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(result.value, accountSlug, input.descriptionFormat, seen, jobPosts);
              // Early-exit if we already have enough.
              if (jobPosts.length >= resultsWanted) break;
            } else {
              this.logger.warn(
                `Recruit CRM page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }
          if (jobPosts.length >= resultsWanted) break;
          if (i + RECRUITCRM_MAX_CONCURRENCY < offsets.length) {
            await randomSleep(RECRUITCRM_REQUEST_DELAY_MS, RECRUITCRM_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Recruit CRM total: ${trimmed.length} jobs for ${accountSlug}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Recruit CRM scrape error for ${accountSlug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch one page of jobs; returns the raw job array. */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    accountSlug: string,
    offset: number,
  ): Promise<RecruitCrmJob[]> {
    const path = RECRUITCRM_JOBS_PATH_TEMPLATE.replace(
      '{account}',
      encodeURIComponent(accountSlug),
    );
    const url = `${RECRUITCRM_ALBATROSS_BASE}${path}`;
    try {
      const response = await client.post<RecruitCrmJobsResponse>(url, {
        limit: RECRUITCRM_PAGE_SIZE,
        offset,
        search_data: {},
        onlyJobs: true,
      });
      const data = response.data ?? {};
      if (data.status === 'fail') {
        this.logger.warn(
          `Recruit CRM account not found or unauthorised for slug "${accountSlug}": ${data.message ?? ''}`,
        );
        return [];
      }
      return Array.isArray(data.data?.jobs) ? (data.data!.jobs as RecruitCrmJob[]) : [];
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 401 || status === 404) {
        this.logger.warn(
          `Recruit CRM account not found (HTTP ${status}) for slug "${accountSlug}"`,
        );
        return [];
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: RecruitCrmJob[],
    accountSlug: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, accountSlug, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(
          `Error processing Recruit CRM job ${job?.slug ?? job?.srno}: ${err.message}`,
        );
      }
    }
  }

  private processJob(
    job: RecruitCrmJob,
    accountSlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name;
    if (!title || !title.trim()) return null;

    const atsId = job.slug;
    if (!atsId || !atsId.trim()) return null;

    const jobUrl = RECRUITCRM_JOB_DETAIL_TEMPLATE.replace('{slug}', encodeURIComponent(atsId));

    // HTML description lives in `jdtext`; plain-text fallback is `description`.
    const rawHtml = job.jdtext ?? null;
    const rawPlain = job.description ?? null;
    let description: string | null = null;
    if (rawHtml && rawHtml.trim()) {
      if (format === DescriptionFormat.HTML) {
        description = rawHtml;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawHtml) ?? rawHtml;
      } else {
        description = htmlToPlainText(rawHtml);
      }
    } else if (rawPlain && rawPlain.trim()) {
      description = rawPlain;
    }

    // Company name: respect the showcompany flag (0 = anonymous).
    const showCompany =
      job.showcompany !== null && job.showcompany !== undefined
        ? Number(job.showcompany)
        : 1;
    const companyName =
      showCompany !== 0 && job.companyname && job.companyname.trim()
        ? job.companyname.trim()
        : this.deriveCompanyName(accountSlug);

    return new JobPostDto({
      id: `recruitcrm-${atsId}`,
      title: title.trim(),
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null, // the feed does not expose a publish timestamp
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.RECRUITCRM,
      atsId,
      atsType: 'recruitcrm',
      department: null, // the feed does not expose a department field
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the Recruit CRM account slug from an explicit slug or a jobs-page
   * URL such as `https://recruitcrm.io/jobs/Terra_Careers`.
   */
  private resolveAccountSlug(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Expected path: /jobs/{slug}  →  last non-empty segment.
        const segments = u.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        if (last && last !== 'jobs') return last;
        // If path is just /jobs, use the first path segment that isn't "jobs".
        const nonJobs = segments.find((s) => s !== 'jobs');
        if (nonJobs) return nonJobs;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Derive a display name from the account slug for use when company is hidden. */
  private deriveCompanyName(accountSlug: string): string {
    return accountSlug
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build a LocationDto from the free-text city / locality / postalcode fields. */
  private extractLocation(job: RecruitCrmJob): LocationDto | null {
    const city = job.city?.trim() || null;
    const locality = job.locality?.trim() || null;
    const postalCode = job.postalcode?.trim() || null;

    if (!city && !locality && !postalCode) return null;

    // `city` is the primary label; `locality` is a sub-region (district).
    // We map city → city, locality → state (nearest semantic equivalent).
    return new LocationDto({
      city: city ?? locality ?? null,
      state: city && locality ? locality : null,
      country: null,
    });
  }

  /** Detect remote roles from the `remote` free-text field or the job title. */
  private detectRemote(job: RecruitCrmJob): boolean {
    const remoteField = job.remote;
    if (typeof remoteField === 'string' && remoteField.trim()) return true;
    const title = job.name;
    if (typeof title === 'string') {
      const v = title.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }
}
