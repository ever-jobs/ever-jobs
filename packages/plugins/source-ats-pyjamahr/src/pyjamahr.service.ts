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
  toDateOnly,
} from '@ever-jobs/common';
import {
  PYJAMAHR_API_BASE,
  PYJAMAHR_PORTAL_BASE,
  PYJAMAHR_ROOT_DOMAIN,
  PYJAMAHR_JOBS_PATH,
  PYJAMAHR_REMOTE_REGEX,
  PYJAMAHR_DEFAULT_RESULTS,
  PYJAMAHR_MAX_PAGES,
  PYJAMAHR_HEADERS,
} from './pyjamahr.constants';
import {
  PyjamaHrJob,
  PyjamaHrJobDetail,
  PyjamaHrJobListItem,
  PyjamaHrJobsListResponse,
} from './pyjamahr.types';

/**
 * PyjamaHR ATS careers scraper — generic, multi-tenant.
 *
 * PyjamaHR (pyjamahr.com, India / global) powers each customer's candidate portal
 * on the shared host `https://jobs.pyjamahr.com/{tenant}` (mirrored under
 * `https://app.pyjamahr.com/careers/{tenant}`). The portal is a client-rendered
 * Next.js SPA, so instead of scraping HTML the adapter consumes the public,
 * unauthenticated JSON API on `api.pyjamahr.com`, keyed by the tenant's
 * `company_slug`: a paginated open-roles list
 * (`/api/career/jobs/?company_slug={tenant}`) and a per-role detail object
 * (`/api/career/jobs/{id}/?company_slug={tenant}`) carrying the full HTML body and
 * metadata.
 *
 * The caller addresses a tenant by `companySlug` (the company slug, e.g.
 * `jobscubicle`) or by `companyUrl` (a portal URL whose path/sub-domain encodes
 * the tenant slug). The list endpoint paginates (`count` / `next`), so we walk
 * pages until we have `resultsWanted` roles, then fetch each role's detail object.
 * An unknown tenant returns HTTP 200 with an empty `results` array; a fetch error,
 * an HTTP 4xx, or a malformed object degrades to an empty / partial result rather
 * than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.PYJAMAHR,
  name: 'PyjamaHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PyjamaHrService implements IScraper {
  private readonly logger = new Logger(PyjamaHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PyjamaHR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a PyjamaHR tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PYJAMAHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? PYJAMAHR_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PyjamaHR jobs for tenant: ${tenant}`);

      // Walk the paginated list endpoint until we have enough roles (deduped).
      const items = await this.fetchJobList(client, tenant, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`PyjamaHR tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        try {
          const post = await this.processItem(client, item, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing PyjamaHR role ${item.id}: ${err.message}`);
        }
      }

      this.logger.log(`PyjamaHR total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PyjamaHR scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Walk the paginated open-roles list for the tenant, accumulating up to
   * `resultsWanted` deduped roles. An unknown tenant returns an empty `results`
   * array (HTTP 200); an HTTP 4xx or a missing list degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<PyjamaHrJobListItem[]> {
    const items: PyjamaHrJobListItem[] = [];
    const base = `${PYJAMAHR_API_BASE}${PYJAMAHR_JOBS_PATH}`;

    for (let page = 1; page <= PYJAMAHR_MAX_PAGES; page++) {
      const url = `${base}?company_slug=${encodeURIComponent(tenant)}&page=${page}`;
      let body: PyjamaHrJobsListResponse | null;
      try {
        const response = await client.get<PyjamaHrJobsListResponse>(url);
        body = this.asObject<PyjamaHrJobsListResponse>(response.data);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`PyjamaHR job list not found (HTTP ${status}) for ${tenant}`);
          break;
        }
        throw err;
      }

      const results = Array.isArray(body?.results) ? (body!.results as PyjamaHrJobListItem[]) : [];
      for (const role of results) {
        const id = this.cleanText(String(role?.id ?? ''));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        if (items.length >= resultsWanted) return items;
      }

      // Stop once the API reports no further page.
      if (!this.cleanText(body?.next ?? null)) break;
    }

    return items;
  }

  /** Fetch + parse a single role's detail object, then map it to a JobPostDto. */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: PyjamaHrJobListItem,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const jobId = this.cleanText(String(item?.id ?? ''));
    if (!jobId) return null;

    let detail: PyjamaHrJobDetail | null = null;
    const url = `${PYJAMAHR_API_BASE}${PYJAMAHR_JOBS_PATH}${encodeURIComponent(
      jobId,
    )}/?company_slug=${encodeURIComponent(tenant)}`;
    try {
      const response = await client.get<PyjamaHrJobDetail>(url);
      detail = this.asObject<PyjamaHrJobDetail>(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip its detail but still map the list item.
        this.logger.warn(`PyjamaHR role ${jobId} detail not found (HTTP ${status})`);
        detail = null;
      } else {
        throw err;
      }
    }

    const job = this.mergeJob(item, detail, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Merge a list item and its (optional) detail object into a normalised PyjamaHrJob. */
  private mergeJob(
    item: PyjamaHrJobListItem,
    detail: PyjamaHrJobDetail | null,
    tenant: string,
  ): PyjamaHrJob {
    const jobId = this.cleanText(String(item?.id ?? detail?.id ?? '')) ?? '';
    const slug = this.cleanText(item?.slug);

    const title = this.cleanText(detail?.title) ?? this.cleanText(item?.title);
    const country = this.cleanText(detail?.country) ?? this.cleanText(item?.country);
    const location = this.cleanText(detail?.location) ?? this.cleanText(item?.location);
    const department =
      this.cleanText(detail?.department_name) ?? this.cleanText(item?.department_name);
    const workplaceType =
      this.cleanText(detail?.workplace_type) ?? this.cleanText(item?.workplace_type);

    return {
      jobId,
      url: this.buildJobUrl(tenant, jobId, slug),
      title,
      companyName: this.deriveCompanyName(tenant),
      descriptionHtml: this.cleanText(detail?.description),
      // The API's `location` is a city / "Remote" token; `country` is the country.
      city: location && !this.isRemoteToken(location) ? location : null,
      state: null,
      country,
      department,
      employmentType: this.normaliseEmploymentType(detail?.job_type),
      datePosted: this.parseDate(detail?.created_at),
      isRemote: this.detectRemote(detail, title, location, workplaceType),
    };
  }

  /** Map a normalised PyjamaHrJob → JobPostDto. */
  private processJob(
    job: PyjamaHrJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `pyjamahr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.PYJAMAHR,
      atsId,
      atsType: 'pyjamahr',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail object's
   * `description` is an HTML body, so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * portal URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on a `pyjamahr.com` host has the tenant taken from its first path segment (or
   * its leading sub-domain label). Returns an empty string when neither yields a
   * tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(PYJAMAHR_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a PyjamaHR portal URL. The candidate-facing forms
   * are `https://jobs.pyjamahr.com/{tenant}` and
   * `https://app.pyjamahr.com/careers/{tenant}`; a bespoke sub-domain
   * (`{tenant}.pyjamahr.com`) is also tolerated.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(PYJAMAHR_ROOT_DOMAIN)) return '';
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      // `/careers/{tenant}` (app host) or `/{tenant}` (jobs host).
      if (segments.length > 0) {
        const first = segments[0].toLowerCase();
        const tenant = first === 'careers' && segments.length > 1 ? segments[1] : first;
        if (tenant && tenant !== 'careers') return decodeURIComponent(tenant).toLowerCase();
      }
      // Fall back to a bespoke `{tenant}.pyjamahr.com` sub-domain label.
      const label = hostname.split('.')[0];
      if (label && label !== 'jobs' && label !== 'app' && label !== 'api' && label !== 'www') {
        return label;
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the canonical public detail / apply URL for a role. */
  private buildJobUrl(tenant: string, jobId: string, slug: string | null): string {
    const base = `${PYJAMAHR_PORTAL_BASE}/${encodeURIComponent(tenant)}`;
    const id = encodeURIComponent(jobId);
    // The portal addresses a role by `?job_uuid={id}`; the slug is carried as a hint.
    return slug
      ? `${base}?job_uuid=${id}&slug=${encodeURIComponent(slug)}`
      : `${base}?job_uuid=${id}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts (city / country) as a LocationDto, leaving
   * location null when nothing usable is present.
   */
  private extractLocation(job: PyjamaHrJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the explicit flag, `workplace_type`, the title, or the location. */
  private detectRemote(
    detail: PyjamaHrJobDetail | null,
    title: string | null,
    location: string | null,
    workplaceType: string | null,
  ): boolean {
    if (detail && detail.remote === true) return true;
    if (workplaceType && /remote/i.test(workplaceType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PYJAMAHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a PyjamaHR `job_type` token (e.g. `FULLTIME`, `PARTTIME`,
   * `CONTRACT`, `INTERNSHIP`) into a readable label (`Full Time`, `Part Time`, …).
   * Free-text values are passed through trimmed + title-cased.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_-]+/g, ' ')
      .replace(/\b(full|part)\s*time\b/i, '$1 time')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time');
    return spaced
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Parse a date string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** Narrow an arbitrary parsed response body to a plain object, or null. */
  private asObject<T>(value: unknown): T | null {
    return value && typeof value === 'object' ? (value as T) : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
