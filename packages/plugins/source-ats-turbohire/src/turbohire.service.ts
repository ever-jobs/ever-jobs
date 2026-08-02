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
  TURBOHIRE_API_BASE,
  TURBOHIRE_PORTAL_BASE,
  TURBOHIRE_ROOT_DOMAIN,
  TURBOHIRE_JOBS_PATH,
  TURBOHIRE_PUBLIC_JOB_PATH,
  TURBOHIRE_REMOTE_REGEX,
  TURBOHIRE_DEFAULT_RESULTS,
  TURBOHIRE_PAGE_SIZE,
  TURBOHIRE_MAX_PAGES,
  TURBOHIRE_HEADERS,
} from './turbohire.constants';
import {
  TurboHireJob,
  TurboHireJobDetail,
  TurboHireJobListItem,
  TurboHireJobsListResponse,
} from './turbohire.types';

/**
 * TurboHire ATS careers scraper — generic, multi-tenant.
 *
 * TurboHire (turbohire.co, India / global) is an AI recruitment-automation ATS that
 * powers each customer's candidate portal on a tenant careers sub-domain
 * (`https://{tenant}.turbohire.co`) and the shared host `careers.turbohire.co`, with
 * per-role public detail pages on `portal.turbohire.co/job/publicjobs/{token}` (and
 * the `app.turbohire.co` mirror). The portal is a client-rendered SPA, so instead of
 * scraping HTML the adapter consumes the public, unauthenticated JSON API the SPA
 * itself uses on `api.turbohire.co`, keyed by the tenant's company / org slug: a
 * paginated open-roles list (`/api/careerpage/publicjobs?companySlug={tenant}`) and a
 * per-role detail object (`/api/careerpage/publicjobs/{id}?companySlug={tenant}`)
 * carrying the full HTML body and metadata.
 *
 * The caller addresses a tenant by `companySlug` (the careers sub-domain label / org
 * slug, e.g. `tatamotors`) or by `companyUrl` (a `turbohire.co` portal URL whose
 * sub-domain encodes the tenant). The list endpoint paginates
 * (`totalCount` / `page` / `pageSize`), so we walk pages until we have
 * `resultsWanted` roles, then fetch each role's detail object. An unknown tenant
 * returns an empty list (or a 4xx); a fetch error, an HTTP 4xx, or a malformed object
 * degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 *
 * NOTE: the platform + tenant addressing were confirmed live (named tenant
 * `tatamotors`, plus the `portal.turbohire.co/job/publicjobs/{token}` detail host),
 * but the exact `api.turbohire.co` JSON wire shapes could not be observed
 * unauthenticated and TurboHire publishes no public API docs. The endpoint paths +
 * field names are a DEFENSIVE design with full graceful degradation. (verified=false)
 */
@SourcePlugin({
  site: Site.TURBOHIRE,
  name: 'TurboHire',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TurboHireService implements IScraper {
  private readonly logger = new Logger(TurboHireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for TurboHire scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a TurboHire tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TURBOHIRE_HEADERS);

    const resultsWanted = input.resultsWanted ?? TURBOHIRE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching TurboHire jobs for tenant: ${tenant}`);

      // Walk the paginated list endpoint until we have enough roles (deduped).
      const items = await this.fetchJobList(client, tenant, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`TurboHire tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        try {
          const post = await this.processItem(client, item, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing TurboHire role ${this.itemId(item)}: ${err.message}`);
        }
      }

      this.logger.log(`TurboHire total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`TurboHire scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Walk the paginated open-roles list for the tenant, accumulating up to
   * `resultsWanted` deduped roles. An unknown tenant returns an empty list (HTTP 200
   * or 4xx); an HTTP 4xx or a missing list degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<TurboHireJobListItem[]> {
    const items: TurboHireJobListItem[] = [];
    const base = `${TURBOHIRE_API_BASE}${TURBOHIRE_JOBS_PATH}`;

    for (let page = 1; page <= TURBOHIRE_MAX_PAGES; page++) {
      const url = `${base}?companySlug=${encodeURIComponent(
        tenant,
      )}&page=${page}&pageSize=${TURBOHIRE_PAGE_SIZE}`;
      let body: TurboHireJobsListResponse | null;
      try {
        const response = await client.get<TurboHireJobsListResponse>(url);
        body = this.asObject<TurboHireJobsListResponse>(response.data);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`TurboHire job list not found (HTTP ${status}) for ${tenant}`);
          break;
        }
        throw err;
      }

      const results = this.extractList(body);
      if (results.length === 0) break;

      for (const role of results) {
        const id = this.itemId(role);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        if (items.length >= resultsWanted) return items;
      }

      // Stop once we have walked the full reported count, or this page wasn't full.
      const total = typeof body?.totalCount === 'number' ? body.totalCount : null;
      if (total != null && items.length >= total) break;
      if (results.length < TURBOHIRE_PAGE_SIZE) break;
    }

    return items;
  }

  /**
   * Pull the roles array out of the list envelope, tolerating the alternate keys a
   * careers API might use (`data` / `results` / `jobs`).
   */
  private extractList(body: TurboHireJobsListResponse | null): TurboHireJobListItem[] {
    if (!body) return [];
    if (Array.isArray(body.data)) return body.data as TurboHireJobListItem[];
    if (Array.isArray(body.results)) return body.results as TurboHireJobListItem[];
    if (Array.isArray(body.jobs)) return body.jobs as TurboHireJobListItem[];
    return [];
  }

  /** Fetch + parse a single role's detail object, then map it to a JobPostDto. */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: TurboHireJobListItem,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const jobId = this.itemId(item);
    if (!jobId) return null;

    let detail: TurboHireJobDetail | null = null;
    const url = `${TURBOHIRE_API_BASE}${TURBOHIRE_JOBS_PATH}/${encodeURIComponent(
      jobId,
    )}?companySlug=${encodeURIComponent(tenant)}`;
    try {
      const response = await client.get<TurboHireJobDetail>(url);
      detail = this.asObject<TurboHireJobDetail>(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip its detail but still map the list item.
        this.logger.warn(`TurboHire role ${jobId} detail not found (HTTP ${status})`);
        detail = null;
      } else {
        throw err;
      }
    }

    const job = this.mergeJob(item, detail, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Merge a list item and its (optional) detail object into a normalised TurboHireJob. */
  private mergeJob(
    item: TurboHireJobListItem,
    detail: TurboHireJobDetail | null,
    tenant: string,
  ): TurboHireJob {
    const jobId = this.itemId(item) ?? this.itemId(detail as TurboHireJobListItem | null) ?? '';

    const title = this.cleanText(detail?.title) ?? this.cleanText(item?.title);
    const city = this.cleanText(detail?.city) ?? this.cleanText(item?.city);
    const state = this.cleanText(detail?.state) ?? this.cleanText(item?.state);
    const country = this.cleanText(detail?.country) ?? this.cleanText(item?.country);
    const location = this.cleanText(detail?.location) ?? this.cleanText(item?.location);
    const department =
      this.cleanText(detail?.departmentName) ?? this.cleanText(item?.departmentName);
    const workplaceType =
      this.cleanText(detail?.workplaceType) ?? this.cleanText(item?.workplaceType);
    const employmentType =
      this.cleanText(detail?.employmentType) ?? this.cleanText(item?.employmentType);

    // Prefer a structured city; otherwise fall back to the combined `location` token
    // (unless it is a bare "Remote" marker).
    const resolvedCity =
      city ?? (location && !this.isRemoteToken(location) ? location : null);

    return {
      jobId,
      url: this.buildJobUrl(item, detail, tenant, jobId),
      title,
      companyName: this.cleanText(detail?.companyName) ?? this.deriveCompanyName(tenant),
      descriptionHtml: this.extractDescription(detail),
      city: resolvedCity,
      state,
      country,
      department,
      employmentType: this.normaliseEmploymentType(employmentType),
      datePosted: this.parseDate(detail?.createdOn ?? detail?.createdAt ?? detail?.publishedOn),
      isRemote: this.detectRemote(item, detail, title, location, workplaceType),
    };
  }

  /** Map a normalised TurboHireJob → JobPostDto. */
  private processJob(
    job: TurboHireJob,
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
      id: `turbohire-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.TURBOHIRE,
      atsId,
      atsType: 'turbohire',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail object's body is an
   * HTML fragment, so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /** Pull the HTML body out of the detail object, tolerating its alternate keys. */
  private extractDescription(detail: TurboHireJobDetail | null): string | null {
    if (!detail) return null;
    return (
      this.cleanText(detail.descriptionHtml) ??
      this.cleanText(detail.description) ??
      this.cleanText(detail.jobDescription)
    );
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * portal URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on a `turbohire.co` host has the tenant taken from its leading sub-domain label
   * (or its first path segment). Returns an empty string when neither yields a
   * tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(TURBOHIRE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a TurboHire portal URL. The candidate-facing forms
   * are `https://{tenant}.turbohire.co` (and `/dashboardv2?orgId=…`); the shared
   * `careers.turbohire.co` host carries the tenant in its first path segment, and a
   * generic `portal` / `app` host yields no tenant.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(TURBOHIRE_ROOT_DOMAIN)) return '';

      const label = hostname.split('.')[0];
      const reserved = new Set(['careers', 'portal', 'app', 'api', 'www', 'jobs']);

      // A tenant careers sub-domain (`{tenant}.turbohire.co`) is the primary form.
      if (label && !reserved.has(label)) {
        return decodeURIComponent(label).toLowerCase();
      }

      // On the shared / portal hosts the tenant is the first path segment, if any.
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length > 0) {
        const first = segments[0].toLowerCase();
        const skip = new Set(['job', 'jobs', 'publicjobs', 'careers', 'dashboardv2']);
        if (first && !skip.has(first)) return decodeURIComponent(first).toLowerCase();
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Build the canonical public detail / apply URL for a role. The API may carry an
   * absolute `publicUrl` / `applyUrl`; otherwise we synthesise the documented
   * `portal.turbohire.co/job/publicjobs/{token}` form from the role id.
   */
  private buildJobUrl(
    item: TurboHireJobListItem,
    detail: TurboHireJobDetail | null,
    tenant: string,
    jobId: string,
  ): string {
    const explicit =
      this.cleanText(detail?.publicUrl) ??
      this.cleanText(detail?.applyUrl) ??
      this.cleanText(item?.publicUrl) ??
      this.cleanText(item?.applyUrl);
    if (explicit) return explicit;
    if (jobId) {
      return `${TURBOHIRE_PORTAL_BASE}${TURBOHIRE_PUBLIC_JOB_PATH}/${encodeURIComponent(jobId)}`;
    }
    // Last resort — the tenant careers landing page.
    return `https://${encodeURIComponent(tenant)}.${TURBOHIRE_ROOT_DOMAIN}/`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts (city / state / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: TurboHireJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the explicit flag, `workplaceType`, the title, or the location. */
  private detectRemote(
    item: TurboHireJobListItem,
    detail: TurboHireJobDetail | null,
    title: string | null,
    location: string | null,
    workplaceType: string | null,
  ): boolean {
    if (detail && detail.isRemote === true) return true;
    if (item && item.isRemote === true) return true;
    if (workplaceType && /remote/i.test(workplaceType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (TURBOHIRE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a TurboHire employment-type token (e.g. `FULLTIME`, `Full Time`,
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
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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

  /** Resolve a role's opaque id / public token from its list item or detail object. */
  private itemId(item: TurboHireJobListItem | null | undefined): string {
    if (!item) return '';
    return (
      this.cleanText(item.id != null ? String(item.id) : null) ??
      this.cleanText(item.publicId != null ? String(item.publicId) : null) ??
      ''
    );
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
