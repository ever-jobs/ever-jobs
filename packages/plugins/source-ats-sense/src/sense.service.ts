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
  SENSE_ROOT_DOMAIN,
  SENSE_CAREER_HOST_SUFFIX,
  SENSE_JOBS_PATH,
  SENSE_JOB_DETAIL_PATH,
  SENSE_PAGE_SIZE,
  SENSE_DEFAULT_RESULTS,
  SENSE_MAX_PAGES,
  SENSE_DEFAULT_TIMEOUT_SECONDS,
  SENSE_HEADERS,
  SENSE_REMOTE_TYPE,
  SENSE_REMOTE_REGEX,
  senseCareerOrigin,
} from './sense.constants';
import { SenseJob, SenseJobRow, SenseJobsResponse } from './sense.types';

/**
 * Sense (sensehq.com) ATS careers scraper — generic, multi-tenant.
 *
 * Sense (sensehq.com — a US recruiting CRM / talent-engagement & TRM platform whose hosted
 * career sites are powered by the Skillate ATS it absorbed) gives each customer tenant a
 * branded, public, unauthenticated candidate-facing career site on the shared host
 * `https://{tenant}.sensehq.com/careers`. Each tenant career site is backed by a **public,
 * anonymous JSON feed** on the same host:
 *
 *   GET https://{tenant}.sensehq.com/careers/api/jobs?page={n}
 *
 * which returns a `{ success, data: { count, rows } }` envelope whose `data.rows[]` array
 * holds the tenant's open roles (no bearer token, no API key — the exact feed the career
 * site's own front-end consumes). The `page` index is 0-based and the server returns a fixed
 * 10-row page size. The adapter GETs this feed, drains pages by index until `rows` is empty
 * (or `count` / `resultsWanted` / the page cap is reached), and maps each row — rather than
 * depending on a client-rendered DOM, a headless browser, or any authenticated Sense TRM API.
 * Each role's numeric `id` (e.g. `217`) is the stable ATS id, and the canonical public detail
 * / apply page is `https://{tenant}.sensehq.com/careers/jobs/{id}`.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `sensehr`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no open
 * roles, or an empty board degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx/5xx, a DNS failure, or a malformed body degrades to an empty / partial result rather
 * than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SENSE,
  name: 'Sense',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SenseService implements IScraper {
  private readonly logger = new Logger(SenseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Sense scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Sense tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Sense career host degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy
    // path keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SENSE_DEFAULT_TIMEOUT_SECONDS,
      SENSE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SENSE_HEADERS);

    const resultsWanted = input.resultsWanted ?? SENSE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Sense jobs for tenant: ${tenant}`);

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the paginated public feed up to the page cap or until we've collected
      // `resultsWanted` roles. The `page` index is 0-based; the server returns a fixed 10-row
      // slice. A transport-level failure (host unreachable) aborts the sweep; an HTTP error /
      // malformed page degrades to an empty / partial result.
      for (let page = 0; page < SENSE_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, tenant, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const rows = Array.isArray(body.data?.rows) ? (body.data?.rows as SenseJobRow[]) : [];
        // An empty page marks the end of the feed (out-of-range `page`).
        if (rows.length === 0) break;

        for (const row of rows) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processRow(row, tenant, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Sense role ${row?.id}: ${err.message}`);
          }
        }

        // Stop once we've walked the whole advertised set (a fixed-size page that is short of
        // the page size is also the last page).
        const total = this.coerceCount(body.data?.count);
        if (total !== null && (page + 1) * SENSE_PAGE_SIZE >= total) break;
        if (rows.length < SENSE_PAGE_SIZE) break;
      }

      this.logger.log(`Sense total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Sense scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the tenant's public jobs feed as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed `{ success, data: { count, rows } }` envelope, or null when the
   *    response carried no usable JSON / the host answered an HTTP error status (4xx / 5xx — a
   *    real, reachable host; an unknown Sense tenant answers HTTP 500).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the tenant host itself is unreachable and the caller should
   *    stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ data: SenseJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(tenant, page);
    try {
      const response = await client.get<SenseJobsResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-path / 5xx unknown-tenant) — it is
        // reachable, but there is nothing more to drain.
        this.logger.warn(`Sense feed returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Sense feed fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses the
   * JSON for us (object body); if a tenant serves the feed as a text/plain string we parse it
   * ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(data: SenseJobsResponse | string | unknown): SenseJobsResponse | null {
    if (data && typeof data === 'object') return data as SenseJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as SenseJobsResponse;
      } catch (err: any) {
        this.logger.warn(`Sense feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processRow(
    row: SenseJobRow,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseRow(row, tenant, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised SenseJob from a parsed role. */
  private normaliseRow(
    row: SenseJobRow,
    tenant: string,
    companyName: string,
  ): SenseJob | null {
    const atsId = this.coerceId(row.id);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, atsId);
    const city = this.cleanText(row.office?.city) ?? this.cleanText(row.location);
    const state = this.cleanText(row.office?.state);
    const country = this.cleanText(row.office?.country);
    const locationText = this.joinLocation(
      this.cleanText(row.location),
      city,
      state,
      country,
    );
    const department = this.cleanText(row.department);
    const title = this.cleanText(row.title);
    const employmentType = this.humanizeJobType(row.job_type);

    return {
      atsId,
      url,
      // The Sense detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName || this.deriveSlugName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(row.description_external),
      department,
      employmentType,
      datePosted: this.parseEpochDate(row.created_on),
      isRemote: this.detectRemote(row, title, locationText, department),
    };
  }

  /** Map a normalised SenseJob → JobPostDto. */
  private processJob(
    job: SenseJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `sense-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SENSE,
      atsId,
      atsType: 'sense',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Sense exposes the body as HTML
   * (`description_external`), so HTML returns it as-is, Markdown converts it, and Plain strips
   * the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a `sensehq.com`
   * host has the tenant taken from its leading sub-domain label. Returns an empty string when
   * neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SENSE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Sense career-site URL. The candidate-facing host is
   * `{tenant}.sensehq.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(SENSE_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - SENSE_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `app` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'app' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Assemble a tenant's public jobs-feed URL for a given (0-based) page. */
  private buildFeedUrl(tenant: string, page: number): string {
    const origin = senseCareerOrigin(tenant);
    const params = new URLSearchParams({ page: String(page) });
    return `${origin}/${SENSE_JOBS_PATH}?${params.toString()}`;
  }

  /** Assemble the canonical `{origin}/careers/jobs/{id}` public detail URL for a role. */
  private buildJobUrl(tenant: string, atsId: string): string {
    const origin = senseCareerOrigin(tenant);
    return `${origin}/${SENSE_JOB_DETAIL_PATH}/${encodeURIComponent(atsId)}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: SenseJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Join the structured + free-text location parts into a single de-duplicated free-text line
   * (used for remote-detection regex). The free-text `location` line is included first since a
   * tenant may set it to `Remote` even when no structured office is present.
   */
  private joinLocation(
    freeText: string | null,
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [freeText, city, state, country].filter((p): p is string => !!p);
    const unique = Array.from(new Set(parts));
    return unique.length > 0 ? unique.join(', ') : null;
  }

  /**
   * Detect remote roles from the structured `workplace_type` token, then from the title,
   * location, or department text.
   */
  private detectRemote(
    row: SenseJobRow,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const workplace = this.cleanText(row.workplace_type);
    if (workplace && workplace.toLowerCase().includes(SENSE_REMOTE_TYPE)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SENSE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Humanise a Sense `job_type` token (e.g. `FULLTIME` → `Full Time`, `PARTTIME` →
   * `Part Time`, `INTERNSHIP` → `Internship`). An unknown token is title-cased as-is; an
   * absent value yields null.
   */
  private humanizeJobType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const token = cleaned.toUpperCase();
    const known: Record<string, string> = {
      FULLTIME: 'Full Time',
      PARTTIME: 'Part Time',
      CONTRACT: 'Contract',
      TEMPORARY: 'Temporary',
      INTERNSHIP: 'Internship',
      FREELANCE: 'Freelance',
      VOLUNTEER: 'Volunteer',
    };
    if (known[token]) return known[token];
    return cleaned
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse an epoch-millisecond timestamp value into a YYYY-MM-DD string. Accepts a number or a
   * numeric string. Non-numeric / out-of-range values yield null.
   */
  private parseEpochDate(value: number | string | null | undefined): string | null {
    let ms: number | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      ms = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && /^\d+$/.test(trimmed)) ms = Number(trimmed);
    }
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
    try {
      const parsed = new Date(ms);
      if (!isNaN(parsed.getTime())) return toDateOnly(ms);
    } catch {
      // ignore
    }
    return null;
  }

  /** Coerce a numeric / string role id into a non-empty string ATS id, else null. */
  private coerceId(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') {
      const v = value.trim();
      return v.length > 0 ? v : null;
    }
    return null;
  }

  /** Coerce the envelope `count` into a non-negative integer, else null. */
  private coerceCount(value: number | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
