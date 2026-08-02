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
  HRONE_ROOT_DOMAIN,
  HRONE_CAREER_HOST_SUFFIX,
  HRONE_CAREER_PORTAL_PATH,
  HRONE_JOBS_PATH,
  HRONE_API_KEY_HEADER,
  HRONE_DOMAIN_CODE_HEADER,
  HRONE_ACCESS_MODE_HEADER,
  HRONE_ACCESS_MODE,
  HRONE_PAGE_SIZE,
  HRONE_DEFAULT_RESULTS,
  HRONE_MAX_PAGES,
  HRONE_DEFAULT_TIMEOUT_SECONDS,
  HRONE_HEADERS,
  HRONE_REMOTE_REGEX,
  hroneCareerOrigin,
  hroneApiOrigin,
} from './hrone.constants';
import { HrOneJob, HrOneJobItem, HrOneJobsResponse } from './hrone.types';

/**
 * HROne (hrone.cloud) ATS careers scraper — generic, multi-tenant.
 *
 * HROne (hrone.cloud, an India-based HRMS, trusted by 2000+ organisations) powers each
 * customer's public, candidate-facing career portal on the shared host
 * `https://{tenant}.hrone.cloud/career-portal`. The portal SPA loads its open roles
 * client-side from an **anonymous, app-id-scoped job-opening feed** on the tenant API host:
 *
 *   POST https://api.{tenant}.hrone.cloud/api/recruitment/referralposting/v1
 *        body:    { positionId: 0, pagination: { pageNumber, pageSize } }
 *        headers: { apiKey: {appId}, domainCode: {dc}, AccessMode: 'W' }
 *
 * (no bearer token / no user session — the per-tenant `appId` plays the role of a publishable
 * read key). The adapter POSTs this feed, drains pages, and maps each posting — rather than
 * depending on a client-rendered DOM, a headless browser, or the authenticated internal HRMS
 * REST API. Each posting's `positionId` (else `requestId` / `jobCode`) is the stable ATS id,
 * and the tenant career-portal page is the canonical public detail / apply URL.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g. `joy`) or by
 * `companyUrl` (a career-portal URL on a `hrone.cloud` host whose leading sub-domain label is
 * the tenant, and whose query string may carry the `appId` + `dc` read key). An unknown
 * tenant, one with no open roles, a missing/incorrect read key, or a malformed body degrades
 * naturally to an empty / partial result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 *
 * Distinct from `source-ats-hron` (HR-ON Recruit, hr-on.com — a Danish ATS): unrelated.
 *
 * Surface confidence: verified=false — the endpoint, request body, header mechanism, and
 * tenant addressing are confirmed from the portal's own Angular bundle + a real career-portal
 * link (2026-06-03), but the JSON response shape is parsed defensively (the live POST is gated
 * by a per-session signed request token the SPA mints, returning HTTP 403 to a non-browser
 * client). The parser tolerates several candidate envelope/field shapes so the adapter
 * degrades gracefully rather than guessing wrong.
 */
@SourcePlugin({
  site: Site.HRONE,
  name: 'HROne',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HrOneService implements IScraper {
  private readonly logger = new Logger(HrOneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for HROne scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveTenant(companySlug, input.companyUrl);
    if (!resolved.tenant) {
      this.logger.warn('Could not resolve a HROne tenant slug from input');
      return new JobResponseDto([]);
    }
    const { tenant, appId, domainCode } = resolved;

    // Cap the per-request timeout so an unresponsive HROne API host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? HRONE_DEFAULT_TIMEOUT_SECONDS,
      HRONE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });

    // Anonymous, app-id-scoped headers. `domainCode` falls back to the tenant slug; `apiKey`
    // is sent only when a read key was supplied (via the companyUrl query string).
    const headers: Record<string, string> = {
      ...HRONE_HEADERS,
      [HRONE_DOMAIN_CODE_HEADER]: domainCode || tenant,
      [HRONE_ACCESS_MODE_HEADER]: HRONE_ACCESS_MODE,
    };
    if (appId) headers[HRONE_API_KEY_HEADER] = appId;
    client.setHeaders(headers);

    const resultsWanted = input.resultsWanted ?? HRONE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching HROne jobs for tenant: ${tenant}`);

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the paginated public feed up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure (host unreachable) aborts the sweep;
      // an HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= HRONE_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, tenant, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = this.extractItems(body);
        if (items.length === 0) break; // empty page → nothing more to drain

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(
              item,
              tenant,
              appId,
              domainCode,
              companyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing HROne role: ${err?.message ?? err}`);
          }
        }

        // Stop when the page returned fewer roles than requested (last page).
        if (items.length < HRONE_PAGE_SIZE) break;
      }

      this.logger.log(`HROne total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`HROne scrape error for ${tenant}: ${err?.message ?? err}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * POST one page of the tenant's public job-opening feed and parse the JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed response envelope, or null when the response carried no usable
   *    JSON / the host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the tenant API host itself is unreachable and the caller should
   *    stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ data: HrOneJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(tenant);
    const requestBody = {
      positionId: 0,
      pagination: { pageNumber: page, pageSize: HRONE_PAGE_SIZE },
    };
    try {
      const response = await client.post<HrOneJobsResponse | string>(url, requestBody);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-tenant / missing read key / 5xx) — it
        // is reachable, but there is nothing more to drain.
        this.logger.warn(`HROne feed returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant API host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`HROne feed fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses the
   * JSON for us (object body); if a tenant serves it as a text/plain string we parse it
   * ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(data: HrOneJobsResponse | string | unknown): HrOneJobsResponse | null {
    if (Array.isArray(data)) return { items: data as HrOneJobItem[] };
    if (data && typeof data === 'object') return data as HrOneJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return { items: parsed as HrOneJobItem[] };
        if (parsed && typeof parsed === 'object') return parsed as HrOneJobsResponse;
      } catch (err: any) {
        this.logger.warn(`HROne feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Narrow the response envelope to the postings array. The exact wrapper is unconfirmed, so
   * several candidate shapes are tried (bare array, `{ data }`, `{ result }`, `{ items }`,
   * `{ jobOpenings }`, `{ postings }`, each optionally wrapping its own `{ items }`).
   */
  private extractItems(body: HrOneJobsResponse): HrOneJobItem[] {
    const candidates: Array<HrOneJobItem[] | { items?: HrOneJobItem[] | null } | null | undefined> = [
      body.items,
      body.jobOpenings,
      body.postings,
      body.data,
      body.result,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
      if (candidate && typeof candidate === 'object' && Array.isArray(candidate.items)) {
        return candidate.items;
      }
    }
    return [];
  }

  /** Map a parsed posting → JobPostDto, deduping by ATS id. */
  private processItem(
    item: HrOneJobItem,
    tenant: string,
    appId: string,
    domainCode: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, appId, domainCode, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised HrOneJob from a parsed posting. */
  private normaliseItem(
    item: HrOneJobItem,
    tenant: string,
    appId: string,
    domainCode: string,
    companyName: string,
  ): HrOneJob | null {
    const atsId =
      this.cleanText(this.toStr(item.positionId)) ??
      this.cleanText(this.toStr(item.requestId)) ??
      this.cleanText(item.jobCode);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, appId, domainCode, atsId);
    const city = this.cleanText(item.cityName);
    const state = this.cleanText(item.stateName);
    const country = this.cleanText(item.countryName);
    const locationText =
      this.joinLocation(city, state, country) ?? this.cleanText(item.location);
    const department = this.cleanText(item.departmentName);
    const title = this.cleanText(item.jobTitle);
    const employmentType = this.cleanText(item.employmentType) ?? this.cleanText(item.jobType);
    const descriptionHtml =
      this.cleanText(item.description) ?? this.cleanText(item.jobDescription);

    return {
      atsId,
      url,
      // The HROne career portal hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName || this.deriveSlugName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml,
      department,
      employmentType,
      datePosted: this.parseDate(item.postedOn ?? item.postingDate ?? item.createdOn),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised HrOneJob → JobPostDto. */
  private processJob(
    job: HrOneJob,
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
      id: `hrone-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HRONE,
      atsId,
      atsType: 'hrone',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. HROne exposes the body as HTML,
   * so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug + anonymous read key. An explicit `companySlug` is used directly
   * (a bare career-portal URL passed as the slug is reduced to its tenant token); a
   * `companyUrl` on a `hrone.cloud` host has the tenant taken from its leading sub-domain
   * label and the `appId` / `dc` read key taken from its query string. Returns an empty tenant
   * when neither yields one.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { tenant: string; appId: string; domainCode: string } {
    // Prefer a full URL (slug-as-URL, or companyUrl) so we can also capture appId / dc.
    const urlCandidate =
      companySlug && (/^https?:\/\//i.test(companySlug) || companySlug.includes(HRONE_ROOT_DOMAIN))
        ? companySlug
        : companyUrl;
    if (urlCandidate) {
      const fromUrl = this.fromUrl(urlCandidate);
      if (fromUrl.tenant) return fromUrl;
    }
    if (companySlug && companySlug.trim()) {
      return { tenant: companySlug.trim().toLowerCase(), appId: '', domainCode: '' };
    }
    return { tenant: '', appId: '', domainCode: '' };
  }

  /**
   * Derive the tenant token + read key from a HROne career-portal URL. The candidate-facing
   * host is `{tenant}.hrone.cloud`; the tenant is the leading sub-domain label. The `appId`
   * and `dc` (domain code) query params carry the anonymous publishable read key.
   */
  private fromUrl(value: string): { tenant: string; appId: string; domainCode: string } {
    const empty = { tenant: '', appId: '', domainCode: '' };
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(HRONE_CAREER_HOST_SUFFIX)) return empty;
      let label = hostname.slice(0, hostname.length - HRONE_CAREER_HOST_SUFFIX.length);
      // `api.{tenant}.hrone.cloud` → strip the leading `api.` to recover the tenant label.
      if (label.startsWith('api.')) label = label.slice('api.'.length);
      // Guard against an empty / `www` / `app` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'app' || label === 'api') return empty;
      const appId = u.searchParams.get('appId') ?? '';
      const domainCode = u.searchParams.get('dc') ?? u.searchParams.get('domainCode') ?? '';
      return { tenant: label.toLowerCase(), appId, domainCode };
    } catch {
      // Malformed URL — no tenant.
    }
    return empty;
  }

  /** Assemble a tenant's public job-opening feed URL (POST endpoint on the API host). */
  private buildFeedUrl(tenant: string): string {
    return `${hroneApiOrigin(tenant)}/${HRONE_JOBS_PATH}`;
  }

  /**
   * Assemble the public career-portal detail / apply URL for a role. The portal is an SPA
   * addressed by `appId` + `dc`; the posting id is surfaced as a `positionId` query param so
   * the link deep-links to the role when the read key is known.
   */
  private buildJobUrl(tenant: string, appId: string, domainCode: string, atsId: string): string {
    const origin = hroneCareerOrigin(tenant);
    const params = new URLSearchParams();
    if (appId) params.set('appId', appId);
    if (domainCode || tenant) params.set('dc', domainCode || tenant);
    params.set('positionId', atsId);
    return `${origin}/${HRONE_CAREER_PORTAL_PATH}?${params.toString()}`;
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
  private extractLocation(job: HrOneJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [city, state, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Detect remote roles from the title, location, or department text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HRONE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable values
   * yield null.
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

  /** Coerce a number / string id-like value to a string, else null. */
  private toStr(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return value;
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
