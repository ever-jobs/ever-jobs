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
  GREYTHR_ROOT_DOMAIN,
  GREYTHR_CAREER_HOST_SUFFIX,
  GREYTHR_PUBLISHED_JOBS_PATH,
  GREYTHR_JOB_PATH,
  GREYTHR_DEFAULT_RESULTS,
  GREYTHR_DEFAULT_TIMEOUT_SECONDS,
  GREYTHR_HEADERS,
  GREYTHR_PUBLISHED_JOBS_BODY,
  GREYTHR_REMOTE_REGEX,
  greythrCareerOrigin,
} from './greythr.constants';
import {
  GreytHrJob,
  GreytHrJobItem,
  GreytHrPublishedJobsResponse,
} from './greythr.types';

/**
 * greytHR (greytHR Recruit) careers scraper — generic, multi-tenant.
 *
 * greytHR (greythr.com, by Greytip Software — India's largest cloud HR & Payroll suite)
 * powers each customer tenant's branded, public, unauthenticated candidate-facing careers
 * board on the shared host `https://{tenant}.greythr.com/hire/jobs/`. That board is a
 * client-rendered single-page app (`<div id="app">` hydrated by a Semantic-UI bundle), so
 * the open roles are NOT embedded in the landing HTML. Instead the SPA fetches the full
 * published-role set from a public, anonymous JSON endpoint on the same host:
 *
 *   POST https://{tenant}.greythr.com/hire/api/career/published_jobs/
 *        body: {}  → { "data": [ { …role… }, … ] }
 *
 * The adapter POSTs that endpoint, reads `data`, and maps each role — rather than scraping
 * a client-rendered DOM, driving a headless browser, or using the authenticated OAuth2
 * `api.greythr.com` REST API. Each role carries a UUID `id` (the stable ATS id), a
 * `title`, a `slug`, an HTML `description`, a `job_type` (employment type), an `is_remote`
 * boolean, a `designation` (role-family label), and a fully-built public `apply_url`
 * (`/hire/jobs/{slug}`) — used as both the detail URL and the apply URL.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `greytip`) or by `companyUrl` (a
 * careers-site URL whose host encodes the tenant slug). An unknown tenant, one with no
 * open roles, or an empty board degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx/5xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.GREYTHR,
  name: 'GreytHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GreytHrService implements IScraper {
  private readonly logger = new Logger(GreytHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for GreytHR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a GreytHR tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive greytHR careers host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? GREYTHR_DEFAULT_TIMEOUT_SECONDS,
      GREYTHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(GREYTHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? GREYTHR_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching GreytHR jobs for tenant: ${tenant}`);

      const jobs = await this.fetchJobs(client, tenant);
      if (jobs == null) {
        this.logger.log(`GreytHR tenant "${tenant}" has no reachable published-roles board`);
        return new JobResponseDto([]);
      }

      if (jobs.length === 0) {
        this.logger.log(`GreytHR tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing GreytHR role ${item?.id}: ${err.message}`);
        }
      }

      this.logger.log(`GreytHR total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`GreytHR scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * POST the tenant's public published-roles endpoint and return the parsed role array.
   * Returns:
   *  - the role array (possibly empty — an empty board is a valid "no roles" result) when
   *    the endpoint responds with a parseable `data` array.
   *  - `null` when the host is unreachable / answered an HTTP error / returned a body with
   *    no usable `data` array (the caller degrades to an empty result).
   * Never throws — every failure degrades gracefully.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<GreytHrJobItem[] | null> {
    const url = `${greythrCareerOrigin(tenant)}${GREYTHR_PUBLISHED_JOBS_PATH}`;

    let body: GreytHrPublishedJobsResponse | null;
    try {
      const response = await client.post<GreytHrPublishedJobsResponse>(
        url,
        GREYTHR_PUBLISHED_JOBS_BODY,
        { responseType: 'json' },
      );
      body = response.data ?? null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown/disabled tenant / 5xx) — reachable
        // but no usable board. Degrade to empty.
        this.logger.warn(`GreytHR board returned HTTP ${status} for ${tenant}`);
      } else {
        // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
        // the tenant host is unreachable. Degrade gracefully.
        this.logger.warn(`GreytHR board fetch failed for ${tenant}: ${err?.message ?? err}`);
      }
      return null;
    }

    if (!body || !Array.isArray(body.data)) {
      // Some bodies arrive as a JSON string (rare) — narrow defensively, else give up.
      const parsed = this.coerceBody(body);
      if (!parsed || !Array.isArray(parsed.data)) return null;
      return parsed.data as GreytHrJobItem[];
    }

    return body.data as GreytHrJobItem[];
  }

  /**
   * Defensive narrowing: if the client handed back the body as a raw JSON string (some
   * transports skip auto-parse when the content-type is unexpected), parse it; otherwise
   * return it unchanged. Returns null when it cannot be coerced to an object.
   */
  private coerceBody(body: unknown): GreytHrPublishedJobsResponse | null {
    if (body && typeof body === 'object') return body as GreytHrPublishedJobsResponse;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') return parsed as GreytHrPublishedJobsResponse;
      } catch (err: any) {
        this.logger.warn(`GreytHR published_jobs JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: GreytHrJobItem,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised GreytHrJob from a parsed role. */
  private normaliseItem(item: GreytHrJobItem, tenant: string, companyName: string): GreytHrJob | null {
    const atsId = this.cleanText(item.id);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, item);
    const title = this.cleanText(item.title);
    const department = this.cleanText(item.designation);
    const employmentType = this.cleanText(item.job_type);

    return {
      atsId,
      url,
      // The greytHR detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName,
      descriptionHtml: this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(item.published_on_career_page ?? item.created_at),
      isRemote: this.detectRemote(item, title, department),
    };
  }

  /** Map a normalised GreytHrJob → JobPostDto. */
  private processJob(job: GreytHrJob, tenant: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `greythr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.GREYTHR,
      atsId,
      atsType: 'greythr',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. greytHR roles expose the
   * body as HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the
   * tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * careers-site URL passed as the slug is reduced to its tenant token); a `companyUrl` on
   * a `greythr.com` host has the tenant taken from its leading sub-domain label. Returns
   * an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(GREYTHR_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a greytHR careers-site URL. The candidate-facing host is
   * `{tenant}.greythr.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(GREYTHR_CAREER_HOST_SUFFIX)) {
        // Not a hosted careers host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - GREYTHR_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `portal` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'portal' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Assemble the public per-role detail URL. The API supplies a fully-qualified
   * `apply_url` (`https://{tenant}.greythr.com/hire/jobs/{slug}`); when it is absent we
   * build `{origin}/hire/jobs/{slug}` from the role slug.
   */
  private buildJobUrl(tenant: string, item: GreytHrJobItem): string {
    const apply = this.cleanText(item.apply_url);
    if (apply) return apply;
    const origin = greythrCareerOrigin(tenant);
    const slug = this.cleanText(item.slug) ?? this.cleanText(item.id) ?? '';
    return `${origin}${GREYTHR_JOB_PATH}/${encodeURIComponent(slug)}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * greytHR's anonymous published-roles payload exposes `locations` only as opaque numeric
   * location-id strings (no human-readable place name), so no structured location is
   * derivable here; location is left null. (A future per-location resolution pass could
   * map the ids via the tenant's dropdown endpoint.)
   */
  private extractLocation(_job: GreytHrJob): LocationDto | null {
    return null;
  }

  /**
   * Detect remote roles from the structured `is_remote` flag, then from the title or
   * designation text.
   */
  private detectRemote(
    item: GreytHrJobItem,
    title: string | null,
    department: string | null | undefined,
  ): boolean {
    if (item.is_remote === true) return true;
    const haystacks: Array<string | null | undefined> = [title, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (GREYTHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string (coercing numbers to text), returning null for empty / nullish values. */
  private cleanText(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
