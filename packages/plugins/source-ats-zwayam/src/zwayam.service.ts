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
  ZWAYAM_API_BASE,
  ZWAYAM_ROOT_DOMAIN,
  ZWAYAM_OPENINGS_DOMAIN,
  ZWAYAM_JOBS_PATH,
  ZWAYAM_JOB_PREVIEW_PATH,
  ZWAYAM_REMOTE_REGEX,
  ZWAYAM_DEFAULT_RESULTS,
  ZWAYAM_DEFAULT_TIMEOUT_SECONDS,
  ZWAYAM_PAGE_SIZE,
  ZWAYAM_MAX_PAGES,
  ZWAYAM_HEADERS,
} from './zwayam.constants';
import {
  ZwayamJob,
  ZwayamJobDetail,
  ZwayamJobListItem,
  ZwayamJobsListResponse,
} from './zwayam.types';

/**
 * A resolved Zwayam tenant: the company slug used as the API path key, plus the
 * career host that keys the `host=` query parameter the platform requires.
 */
interface ZwayamTenant {
  /** Tenant slug — the `/company/{slug}/jobs` path key + display-name source. */
  slug: string;
  /** Career host (e.g. `acme.openings.co`) — the `host=` query parameter. */
  host: string;
}

/**
 * Zwayam ATS careers scraper — generic, multi-tenant.
 *
 * Zwayam (zwayam.com, India — out of the Naukri.com / Info Edge stable, now part of
 * SHL) powers each customer's candidate-facing career site under a custom career
 * domain (`https://{tenant}.openings.co/` or a vanity host such as
 * `https://careers.beacon-india.com/`), with the career page itself under a tenant
 * slug path (`https://{careerHost}/{tenant}/`). The career page is a client-rendered
 * SPA, so instead of scraping HTML the adapter consumes the public, unauthenticated
 * JSON surface on the shared API origin `api.zwayam.com` (mirrored
 * `public.zwayam.com`), keyed by the tenant slug + career host: a paginated
 * open-roles list (`/company/{tenant}/jobs?host={careerHost}`) plus each role's
 * preview / detail object (`/job_preview/?jobUrl={jobSlug}&host={careerHost}`)
 * carrying the full HTML body and metadata.
 *
 * The caller addresses a tenant by `companySlug` (the company slug, optionally a
 * `{slug}:{host}` pair) or by `companyUrl` (a career-site URL whose host + first path
 * segment encode the career host and tenant slug). The list endpoint paginates
 * (`totalPages` / `number`), so we walk pages until we have `resultsWanted` roles. An
 * unknown / disabled tenant returns an empty list (or an HTTP 4xx); a fetch error, an
 * HTTP 4xx, or a malformed object degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 *
 * Surface confidence: verified=false. The platform, the career-site addressing, the
 * shared API origin, and the canonical per-role preview URL were confirmed live
 * (2026-06-03); the exact open-roles *list* wire shape is a defensive design (SPA +
 * timing-out anonymous hosts), so all parsing is defensively narrowed and every
 * network / parse failure degrades gracefully.
 */
@SourcePlugin({
  site: Site.ZWAYAM,
  name: 'Zwayam',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ZwayamService implements IScraper {
  private readonly logger = new Logger(ZwayamService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Zwayam scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Zwayam tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      // The createHttpClient factory keys off `requestTimeout` (seconds), and
      // ScraperInputDto defaults it to 60s, so a plain pass-through would let an
      // unresponsive Zwayam host hang the scrape on the shared 60s default. Cap
      // the upper end at ZWAYAM_DEFAULT_TIMEOUT_SECONDS so degradation stays fast
      // and well inside callers' budgets; a caller may still request shorter.
      requestTimeout: Math.min(
        input.requestTimeout ?? ZWAYAM_DEFAULT_TIMEOUT_SECONDS,
        ZWAYAM_DEFAULT_TIMEOUT_SECONDS,
      ),
    });
    client.setHeaders(ZWAYAM_HEADERS);

    const resultsWanted = input.resultsWanted ?? ZWAYAM_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Zwayam jobs for tenant: ${tenant.slug} (host: ${tenant.host})`);

      // Walk the paginated list endpoint until we have enough roles (deduped).
      const items = await this.fetchJobList(client, tenant, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Zwayam tenant "${tenant.slug}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        try {
          const post = await this.processItem(client, item, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Zwayam role ${this.itemId(item)}: ${err.message}`);
        }
      }

      this.logger.log(`Zwayam total: ${jobPosts.length} jobs for ${tenant.slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Zwayam scrape error for ${tenant.slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Walk the paginated open-roles list for the tenant, accumulating up to
   * `resultsWanted` deduped roles. An unknown / disabled tenant returns an empty list
   * (or HTTP 4xx); an HTTP 4xx or a missing list degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: ZwayamTenant,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<ZwayamJobListItem[]> {
    const items: ZwayamJobListItem[] = [];
    const base = `${ZWAYAM_API_BASE}${ZWAYAM_JOBS_PATH}/${encodeURIComponent(tenant.slug)}/jobs`;

    for (let page = 0; page < ZWAYAM_MAX_PAGES; page++) {
      const url =
        `${base}?host=${encodeURIComponent(tenant.host)}` +
        `&page=${page}&size=${ZWAYAM_PAGE_SIZE}`;
      let body: ZwayamJobsListResponse | null;
      try {
        const response = await client.get<ZwayamJobsListResponse>(url);
        body = this.asObject<ZwayamJobsListResponse>(response.data);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(`Zwayam job list not found (HTTP ${status}) for ${tenant.slug}`);
          break;
        }
        throw err;
      }

      const results = this.extractListItems(body);
      for (const role of results) {
        const id = this.itemId(role);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        if (items.length >= resultsWanted) return items;
      }

      // Stop once the API reports the last page, no further roles, or no pagination.
      if (results.length === 0) break;
      if (body?.last === true) break;
      const totalPages = typeof body?.totalPages === 'number' ? body!.totalPages : null;
      if (totalPages != null && page + 1 >= totalPages) break;
    }

    return items;
  }

  /** Fetch + parse a single role's preview / detail object, then map it to a JobPostDto. */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: ZwayamJobListItem,
    tenant: ZwayamTenant,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const jobId = this.itemId(item);
    if (!jobId) return null;

    let detail: ZwayamJobDetail | null = null;
    // If the list item already carries a body we can skip the per-role fetch.
    const listBody = this.cleanText(item?.jobDescription) ?? this.cleanText(item?.description);
    if (!listBody) {
      const url =
        `${ZWAYAM_API_BASE}${ZWAYAM_JOB_PREVIEW_PATH}` +
        `?jobUrl=${encodeURIComponent(jobId)}` +
        `&host=${encodeURIComponent(tenant.host)}` +
        `&apiDomain=api.zwayam.com`;
      try {
        const response = await client.get<ZwayamJobDetail>(url);
        detail = this.asObject<ZwayamJobDetail>(response.data);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) {
          // A closed / removed role 404s; skip its detail but still map the list item.
          this.logger.warn(`Zwayam role ${jobId} detail not found (HTTP ${status})`);
          detail = null;
        } else {
          throw err;
        }
      }
    }

    const job = this.mergeJob(item, detail, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Merge a list item and its (optional) detail object into a normalised ZwayamJob. */
  private mergeJob(
    item: ZwayamJobListItem,
    detail: ZwayamJobDetail | null,
    tenant: ZwayamTenant,
  ): ZwayamJob {
    const jobId = this.itemId(item) ?? this.cleanText(String(detail?.jobId ?? '')) ?? '';

    const title =
      this.cleanText(detail?.jobTitle) ??
      this.cleanText(detail?.title) ??
      this.cleanText(item?.jobTitle) ??
      this.cleanText(item?.title);
    const country = this.cleanText(detail?.country) ?? this.cleanText(item?.country);
    const city = this.cleanText(detail?.city) ?? this.cleanText(item?.city);
    const state = this.cleanText(detail?.state) ?? this.cleanText(item?.state);
    const location = this.cleanText(detail?.location) ?? this.cleanText(item?.location);
    const department = this.cleanText(detail?.department) ?? this.cleanText(item?.department);
    const workplaceType =
      this.cleanText(detail?.workplaceType) ?? this.cleanText(item?.workplaceType);
    const employmentType =
      this.cleanText(detail?.employmentType) ??
      this.cleanText(detail?.jobType) ??
      this.cleanText(item?.employmentType) ??
      this.cleanText(item?.jobType);
    const descriptionHtml =
      this.cleanText(detail?.jobDescription) ??
      this.cleanText(detail?.description) ??
      this.cleanText(item?.jobDescription) ??
      this.cleanText(item?.description);
    const datePosted = this.parseDate(
      detail?.postedDate ?? detail?.createdDate ?? item?.postedDate ?? item?.createdDate,
    );

    return {
      jobId,
      url: this.buildJobUrl(tenant, jobId),
      title,
      companyName: this.deriveCompanyName(tenant.slug),
      descriptionHtml,
      // Prefer explicit city; otherwise treat a non-"Remote" location token as the city.
      city: city ?? (location && !this.isRemoteToken(location) ? location : null),
      state,
      country,
      department,
      employmentType: this.normaliseEmploymentType(employmentType),
      datePosted,
      isRemote: this.detectRemote(item, detail, title, location, workplaceType),
    };
  }

  /** Map a normalised ZwayamJob → JobPostDto. */
  private processJob(
    job: ZwayamJob,
    tenant: ZwayamTenant,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant.slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `zwayam-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.ZWAYAM,
      atsId,
      atsType: 'zwayam',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail object's
   * `jobDescription` is an HTML body, so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant + host; a `{slug}:{host}` pair is
   * split); a `companyUrl` on a Zwayam-recognised host has the slug taken from its
   * first path segment and the host from the URL's hostname. Returns null when neither
   * yields a tenant.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): ZwayamTenant | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes('/')) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // A caller may pass a `{slug}:{host}` pair (slug + explicit career host).
      if (slug.includes(':') && !/^https?:/i.test(slug)) {
        const [s, h] = slug.split(':');
        const cleanSlug = this.cleanText(s);
        const cleanHost = this.cleanText(h);
        if (cleanSlug) {
          return {
            slug: cleanSlug.toLowerCase(),
            host: (cleanHost ?? this.defaultHost(cleanSlug)).toLowerCase(),
          };
        }
      }
      const bare = slug.toLowerCase();
      return { slug: bare, host: this.defaultHost(bare) };
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive the tenant slug + career host from a Zwayam career-site URL. The
   * candidate-facing form is `https://{careerHost}/{tenant}/` (e.g.
   * `careers.beacon-india.com/beacon-india/` or `acme.openings.co/acme/`); the host is
   * the career host and the first path segment is the tenant slug. When no path
   * segment is present, the leading sub-domain label is used as the slug.
   */
  private tenantFromUrl(value: string): ZwayamTenant | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!host) return null;
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length > 0) {
        const first = decodeURIComponent(segments[0]).toLowerCase();
        if (first && first !== 'job_preview' && first !== 'company') {
          return { slug: first, host };
        }
      }
      // No usable path segment — fall back to the leading sub-domain label as the slug.
      const label = host.split('.')[0];
      if (label && label !== 'www' && label !== 'api' && label !== 'public' && label !== 'careers') {
        return { slug: label, host };
      }
      // Vanity `careers.{brand}.com` host with no path: derive slug from the brand label.
      const parts = host.split('.');
      if (parts.length >= 2) {
        const brand = parts[parts.length - 2];
        if (brand) return { slug: brand, host };
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return null;
  }

  /** The default Zwayam-hosted career host for a tenant slug (`{slug}.openings.co`). */
  private defaultHost(slug: string): string {
    return `${slug}.${ZWAYAM_OPENINGS_DOMAIN}`;
  }

  /** Build the canonical public preview / apply URL for a role. */
  private buildJobUrl(tenant: ZwayamTenant, jobId: string): string {
    const id = encodeURIComponent(jobId);
    const host = encodeURIComponent(tenant.host);
    return `${ZWAYAM_API_BASE}${ZWAYAM_JOB_PREVIEW_PATH}?jobUrl=${id}&host=${host}&apiDomain=api.zwayam.com`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** The stable per-role id (slug) of a list item, normalised to a string or null. */
  private itemId(item: ZwayamJobListItem): string | null {
    return this.cleanText(item?.jobUrl) ?? this.cleanText(String(item?.jobId ?? ''));
  }

  /**
   * Pull the role array out of the paginated envelope, tolerating either the Spring
   * `content[]` shape, an alternate `jobs[]` key, or a bare top-level array.
   */
  private extractListItems(body: ZwayamJobsListResponse | null): ZwayamJobListItem[] {
    if (!body) return [];
    if (Array.isArray(body.content)) return body.content as ZwayamJobListItem[];
    if (Array.isArray(body.jobs)) return body.jobs as ZwayamJobListItem[];
    if (Array.isArray(body)) return body as ZwayamJobListItem[];
    return [];
  }

  /**
   * Surface the role's location parts (city / state / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: ZwayamJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the explicit flag, `workplaceType`, the title, or the location. */
  private detectRemote(
    item: ZwayamJobListItem,
    detail: ZwayamJobDetail | null,
    title: string | null,
    location: string | null,
    workplaceType: string | null,
  ): boolean {
    if (detail && detail.remote === true) return true;
    if (item && item.remote === true) return true;
    if (workplaceType && /remote/i.test(workplaceType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (ZWAYAM_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a Zwayam employment-type token (e.g. `FULLTIME`, `FULL_TIME`,
   * `Full Time`, `CONTRACT`, `INTERNSHIP`) into a readable label. Free-text values are
   * passed through trimmed + title-cased.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_-]+/g, ' ')
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
