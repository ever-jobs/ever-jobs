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
  RECRUITEZE_ROOT_DOMAIN,
  RECRUITEZE_CAREER_HOST_SUFFIX,
  RECRUITEZE_BOARD_PATH,
  RECRUITEZE_JOBS_PATH,
  RECRUITEZE_COMPANY_ID_REGEX,
  RECRUITEZE_PAGE_SIZE,
  RECRUITEZE_DEFAULT_RESULTS,
  RECRUITEZE_MAX_PAGES,
  RECRUITEZE_DEFAULT_TIMEOUT_SECONDS,
  RECRUITEZE_HEADERS,
  RECRUITEZE_REMOTE_REGEX,
  recruitezeCareerOrigin,
} from './recruiteze.constants';
import { RecruitezeJob, RecruitezeJobItem, RecruitezeJobsResponse } from './recruiteze.types';

/**
 * Recruiteze ATS careers scraper — generic, multi-tenant.
 *
 * Recruiteze (recruiteze.com — a US SMB applicant-tracking system used by hundreds of small
 * businesses and staffing agencies) powers each customer's branded, public, unauthenticated
 * candidate-facing career board on the shared host `https://{tenant}.recruiteze.com/Jobs/AllJobs`.
 * The board renders its role list with a jQuery DataTables grid backed by a **public,
 * anonymous** server-side endpoint on the same host:
 *
 *   POST https://{tenant}.recruiteze.com/Jobs/LoadFilteredJobs
 *     body: companyId={token}&stateId=0&jobTypeId=0&appId=&custom=&draw={n}&start={o}&length={k}
 *     → JSON DataTables envelope { draw, recordsTotal, recordsFiltered, data: [ …roles… ] }
 *
 * The per-tenant `companyId` is an opaque encrypted token the board page renders into a
 * hidden `#hdnCompanyID` input. The adapter first GETs `/Jobs/AllJobs` to harvest that token,
 * then POSTs `LoadFilteredJobs`, draining pages by `start` + `length` (bounded by a page cap),
 * and maps each `data[]` role — rather than depending on the client-rendered DOM or a headless
 * browser. Each role's numeric `ID` is the stable ATS id, and its `Url` is the canonical
 * public detail / apply page (`/jobs/jobdetail?id={encryptedId}`).
 *
 * The caller addresses a tenant by `companySlug` (e.g. `spearmc`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no open
 * roles, an empty board, or a missing company token degrades naturally to an empty result. A
 * fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.RECRUITEZE,
  name: 'Recruiteze',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecruitezeService implements IScraper {
  private readonly logger = new Logger(RecruitezeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Recruiteze scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Recruiteze tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Recruiteze career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys: the
    // no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller may
    // request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? RECRUITEZE_DEFAULT_TIMEOUT_SECONDS,
      RECRUITEZE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(RECRUITEZE_HEADERS);

    const resultsWanted = input.resultsWanted ?? RECRUITEZE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Recruiteze jobs for tenant: ${tenant}`);

      // The role grid is keyed by the tenant's encrypted companyId, harvested from the
      // board page's hidden #hdnCompanyID input. Without it the grid endpoint returns
      // nothing usable, so a missing token degrades to an empty result.
      const companyId = await this.fetchCompanyId(client, tenant);
      if (!companyId) {
        this.logger.warn(`No Recruiteze companyId token found for tenant: ${tenant}`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the paginated DataTables grid up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure (host unreachable) aborts the
      // sweep; an HTTP error / malformed page degrades to an empty / partial result.
      let drawn = 0;
      for (let page = 0; page < RECRUITEZE_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const start = page * RECRUITEZE_PAGE_SIZE;
        const result = await this.fetchPage(client, tenant, companyId, start, page + 1);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.data) ? body.data : [];
        if (items.length === 0) break; // empty page → nothing further to drain
        drawn += items.length;

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Recruiteze role ${item?.ID}: ${err.message}`);
          }
        }

        // Stop when we've drained the whole filtered set (DataTables reports the total).
        const total = this.toFiniteNumber(body.recordsFiltered) ?? this.toFiniteNumber(body.recordsTotal);
        if (total !== null && drawn >= total) break;
        // Defensive: a short page (fewer rows than requested) means we hit the end.
        if (items.length < RECRUITEZE_PAGE_SIZE) break;
      }

      this.logger.log(`Recruiteze total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Recruiteze scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET the tenant's public career board page and harvest the encrypted `companyId` token
   * from its hidden `#hdnCompanyID` input. Returns null on any failure (host unreachable,
   * HTTP error, or a page that does not carry the token) — never throws.
   */
  private async fetchCompanyId(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string | null> {
    const url = `${recruitezeCareerOrigin(tenant)}/${RECRUITEZE_BOARD_PATH}`;
    try {
      const response = await client.get<string>(url, {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const match = RECRUITEZE_COMPANY_ID_REGEX.exec(html);
      const token = match?.[1]?.trim();
      return token && token.length > 0 ? token : null;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.warn(
        `Recruiteze board page fetch failed for ${tenant}${status ? ` (HTTP ${status})` : ''}: ${
          err?.message ?? err
        }`,
      );
      return null;
    }
  }

  /**
   * POST one page of the tenant's public DataTables grid as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed `{ draw, recordsTotal, recordsFiltered, data }` envelope, or null
   *    when the response carried no usable JSON / the host answered an HTTP error status
   *    (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused
   *    / reset / timeout), where the tenant host itself is unreachable and the caller should
   *    stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    companyId: string,
    start: number,
    draw: number,
  ): Promise<{ data: RecruitezeJobsResponse | null; hostReachable: boolean }> {
    const url = `${recruitezeCareerOrigin(tenant)}/${RECRUITEZE_JOBS_PATH}`;
    const body = this.buildFormBody(companyId, start, draw);
    try {
      const response = await client.post<RecruitezeJobsResponse | string>(url, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      });
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-tenant / 5xx) — it is reachable,
        // but there is nothing more to drain.
        this.logger.warn(`Recruiteze grid returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Recruiteze grid fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Assemble the form-encoded DataTables request body the board grid sends. We mirror the
   * grid's own POST: the tenant `companyId`, no state / type filter (ingest the full set),
   * and the standard DataTables paging fields (`draw` / `start` / `length`).
   */
  private buildFormBody(companyId: string, start: number, draw: number): string {
    const params = new URLSearchParams();
    params.set('companyId', companyId);
    params.set('appId', '');
    params.set('stateId', '0');
    params.set('jobTypeId', '0');
    params.set('custom', '');
    params.set('draw', String(draw));
    params.set('start', String(start));
    params.set('length', String(RECRUITEZE_PAGE_SIZE));
    params.set('search[value]', '');
    params.set('search[regex]', 'false');
    return params.toString();
  }

  /**
   * Coerce an axios response body into a parsed grid envelope. The client usually parses the
   * JSON for us (object body); if a tenant serves it as a text/plain string we parse it
   * ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(data: RecruitezeJobsResponse | string | unknown): RecruitezeJobsResponse | null {
    if (data && typeof data === 'object') return data as RecruitezeJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as RecruitezeJobsResponse;
      } catch (err: any) {
        this.logger.warn(`Recruiteze grid JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: RecruitezeJobItem,
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

  /** Build a normalised RecruitezeJob from a parsed role. */
  private normaliseItem(
    item: RecruitezeJobItem,
    tenant: string,
    companyName: string,
  ): RecruitezeJob | null {
    const atsId = this.idToString(item.ID) ?? this.idToString(item.RecruitezeID);
    if (!atsId) return null;

    // The grid always carries the canonical detail URL in `Url`; fall back to a derived
    // origin/id only if a future shape ever omits it.
    const url = this.cleanText(item.Url) ?? this.buildJobUrl(tenant, atsId);
    const city = this.cleanText(item.City);
    const state = this.cleanText(item.State);
    const locationText =
      this.cleanText(item.LocationWithComma) ??
      this.cleanText(item.Location) ??
      this.joinLocation(city, state);
    const title = this.cleanText(item.JobTitle);

    return {
      atsId,
      url,
      // The Recruiteze detail page hosts the apply flow inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName || this.deriveSlugName(tenant),
      city,
      state,
      locationText,
      descriptionHtml: this.cleanText(item.Snippet) ?? this.cleanText(item.DisplayText),
      datePosted: this.parseDate(item.PostedDate),
      isRemote: this.detectRemote(title, locationText),
    };
  }

  /** Map a normalised RecruitezeJob → JobPostDto. */
  private processJob(
    job: RecruitezeJob,
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
      id: `recruiteze-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.RECRUITEZE,
      atsId,
      atsType: 'recruiteze',
      department: null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Recruiteze exposes the body
   * as a (mostly plain-text) snippet; HTML returns it as-is, Markdown converts it, and Plain
   * strips any stray tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a
   * `recruiteze.com` host has the tenant taken from its leading sub-domain label. Returns an
   * empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(RECRUITEZE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Recruiteze career-site URL. The candidate-facing host is
   * `{tenant}.recruiteze.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(RECRUITEZE_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - RECRUITEZE_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `app` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'app' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Assemble a fallback `{origin}/jobs/jobdetail?id={id}` public detail URL for a role. Only
   * used if a future grid shape ever omits the canonical `Url`.
   */
  private buildJobUrl(tenant: string, atsId: string): string {
    const origin = recruitezeCareerOrigin(tenant);
    return `${origin}/jobs/jobdetail?id=${encodeURIComponent(atsId)}`;
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
  private extractLocation(job: RecruitezeJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    if (!city && !state) return null;
    return new LocationDto({ city, state });
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(city: string | null, state: string | null): string | null {
    const parts = [city, state].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Detect remote roles from the title or location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (RECRUITEZE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a Recruiteze posted-date value (e.g. `30 Jan 2025`, or an ISO timestamp) into a
   * YYYY-MM-DD string. Non-absolute / unparseable values yield null.
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

  /** Coerce a numeric / string id into a non-empty string id, else null. */
  private idToString(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Coerce a value into a finite number, else null. */
  private toFiniteNumber(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
