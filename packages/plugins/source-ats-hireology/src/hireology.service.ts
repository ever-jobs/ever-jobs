import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
  toDateOnly,
} from '@ever-jobs/common';
import {
  HIREOLOGY_CAREERS_HOST,
  HIREOLOGY_API_HOST,
  HIREOLOGY_CAREERS_PAGE_TEMPLATE,
  HIREOLOGY_JOBS_PATH_TEMPLATE,
  HIREOLOGY_JOB_PAGE_TEMPLATE,
  HIREOLOGY_TOKEN_REGEX,
  HIREOLOGY_PAGE_SIZE,
  HIREOLOGY_MAX_CONCURRENCY,
  HIREOLOGY_DEFAULT_RESULTS,
  HIREOLOGY_HEADERS,
} from './hireology.constants';
import { HireologyJob, HireologyJobsResponse } from './hireology.types';

/**
 * Hireology ATS careers scraper — generic, multi-tenant.
 *
 * Hireology serves every customer's public careers site from one shared host
 * (`https://careers.hireology.com/{slug}`). That page is a thin React SPA that
 * bootstraps an inline `window.startingData` config carrying the JSON API base
 * URL and a short-lived, anonymous, public bearer token. We first fetch the
 * careers shell, scrape the public token out of it, then page the public jobs
 * feed (`GET https://api.hireology.com/v2/public/careers/{slug}`) which returns
 * `{ data, count, page, page_size }`. The first page yields the true `count`;
 * any remaining pages are fanned out concurrently (bounded) and merged with
 * `Promise.allSettled` so a single transient page failure never nukes the batch.
 *
 * The tenant slug is taken from `companySlug` or derived from a custom
 * `companyUrl` (the first careers path segment, else the first sub-domain
 * label). A missing slug, an unknown tenant (HTTP 404 / no bootstrap token), or
 * any fetch error degrades to an empty/partial result rather than throwing, so
 * a single tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.HIREOLOGY,
  name: 'Hireology',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HireologyService implements IScraper {
  private readonly logger = new Logger(HireologyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Hireology scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Hireology tenant slug from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HIREOLOGY_HEADERS);

    const resultsWanted = input.resultsWanted ?? HIREOLOGY_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Hireology jobs for tenant: ${slug}`);

      // The careers SPA mints an anonymous public bearer token into its shell;
      // scrape it before calling the JSON feed.
      const token = await this.fetchPublicToken(client, slug);
      if (!token) {
        this.logger.warn(`Hireology tenant "${slug}" returned no public token`);
        return new JobResponseDto([]);
      }

      // First page → roles + the tenant's true total count.
      const first = await this.fetchPage(client, slug, token, 1);
      this.collect(first.data, slug, companyName, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.count || jobPosts.length, resultsWanted);

      if (jobPosts.length < total && first.data.length === HIREOLOGY_PAGE_SIZE) {
        const pages: number[] = [];
        for (let page = 2; (page - 1) * HIREOLOGY_PAGE_SIZE < total; page += 1) {
          pages.push(page);
        }

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < pages.length; i += HIREOLOGY_MAX_CONCURRENCY) {
          const chunk = pages.slice(i, i + HIREOLOGY_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((page) => this.fetchPage(client, slug, token, page)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(result.value.data, slug, companyName, input.descriptionFormat, seen, jobPosts);
            } else {
              this.logger.warn(`Hireology page fetch failed: ${result.reason?.message ?? result.reason}`);
            }
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Hireology total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Hireology scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch the careers SPA shell and lift the anonymous public bearer token out
   * of its inline `window.startingData` bootstrap blob. Returns '' when the
   * tenant is unknown (HTTP 404) or no token is present.
   */
  private async fetchPublicToken(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<string> {
    const path = HIREOLOGY_CAREERS_PAGE_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const url = `${HIREOLOGY_CAREERS_HOST}${path}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const match = HIREOLOGY_TOKEN_REGEX.exec(html);
      return match?.[1] ?? '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`Hireology tenant "${slug}" not found (HTTP ${status})`);
        return '';
      }
      throw err;
    }
  }

  /** Fetch one page of the tenant's public jobs feed. */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    token: string,
    page: number,
  ): Promise<{ data: HireologyJob[]; count: number }> {
    const path = HIREOLOGY_JOBS_PATH_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(HIREOLOGY_PAGE_SIZE),
    });
    const url = `${HIREOLOGY_API_HOST}${path}?${params.toString()}`;
    try {
      const response = await client.get<HireologyJobsResponse>(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = response.data ?? {};
      return {
        data: Array.isArray(body.data) ? body.data : [],
        count: body.count ?? 0,
      };
    } catch (err: any) {
      // An unknown / dead tenant returns HTTP 404; treat as "no jobs".
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`Hireology feed for "${slug}" returned HTTP ${status}`);
        return { data: [], count: 0 };
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: HireologyJob[],
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, slug, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Hireology job ${job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: HireologyJob,
    slug: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name ?? job.title ?? job.seo_page_title;
    if (!title) return null;

    const atsId = String(job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, slug, atsId);
    const applyUrl = this.buildApplyUrl(job, jobUrl);

    const rawDescription = job.job_description ?? job.jobDescription ?? job.seo_description ?? null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const family = job.job_family ?? job.jobFamily;
    const department = family?.name ?? null;

    return new JobPostDto({
      id: `hireology-${atsId}`,
      title,
      companyName: job.organization?.name ?? companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.created_at ?? job.createdAt ?? job.updated_at),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.HIREOLOGY,
      atsId,
      atsType: 'hireology',
      department,
      employmentType: job.employment_status ?? job.employmentStatus ?? null,
      applyUrl,
    });
  }

  /** Resolve the careers slug from an explicit slug or a custom careers URL. */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Hireology careers pages encode the tenant as the first path segment:
        // careers.hireology.com/{slug}.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments[0]) return segments[0];
        // Otherwise fall back to the first sub-domain label (custom domains).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www' && label !== 'careers') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL, preferring the feed's own URL. */
  private buildJobUrl(job: HireologyJob, slug: string, atsId: string): string {
    const absolute = job.career_site_url ?? job.careerSiteUrl;
    if (absolute && /^https?:\/\//i.test(absolute)) return absolute;
    const relative = job.career_site_path ?? job.careerSitePath;
    if (relative && relative.startsWith('/')) return `${HIREOLOGY_CAREERS_HOST}${relative}`;
    const path = HIREOLOGY_JOB_PAGE_TEMPLATE.replace('{slug}', encodeURIComponent(slug)).replace(
      '{id}',
      encodeURIComponent(atsId),
    );
    return `${HIREOLOGY_CAREERS_HOST}${path}`;
  }

  /** Build the apply URL, preferring the feed's relative application path. */
  private buildApplyUrl(job: HireologyJob, jobUrl: string): string {
    const applyPath = job.application_path ?? job.applicationPath;
    if (applyPath && applyPath.startsWith('/')) return `${HIREOLOGY_CAREERS_HOST}${applyPath}`;
    if (applyPath && /^https?:\/\//i.test(applyPath)) return applyPath;
    return jobUrl;
  }

  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Hireology emits a structured `locations` array (city/state/zip/address). */
  private extractLocation(job: HireologyJob): LocationDto | null {
    const locations = job.locations;
    if (!Array.isArray(locations) || locations.length === 0) return null;
    const first = locations[0];
    if (!first || typeof first !== 'object') return null;
    const city = first.city ?? null;
    const state = first.state ?? null;
    const country = first.country ?? null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the explicit flag, location, or the title. */
  private detectRemote(job: HireologyJob): boolean {
    if (job.remote === true) return true;
    const haystacks: Array<string | null | undefined> = [
      job.name ?? job.title,
      job.locations?.[0]?.city,
      job.locations?.[0]?.state,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or ISO strings into a YYYY-MM-DD string. */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
