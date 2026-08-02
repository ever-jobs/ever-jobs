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
  WORKWISE_ROOT_DOMAIN,
  WORKWISE_CAREER_HOST_SUFFIX,
  WORKWISE_API_ORIGIN,
  WORKWISE_JOBS_SEARCH_PATH,
  WORKWISE_PAGE_SIZE,
  WORKWISE_DEFAULT_RESULTS,
  WORKWISE_MAX_PAGES,
  WORKWISE_DEFAULT_TIMEOUT_SECONDS,
  WORKWISE_HEADERS,
  WORKWISE_REMOTE_TYPE,
  WORKWISE_REMOTE_REGEX,
  workwiseCareerOrigin,
  workwiseJobUrl,
} from './workwise.constants';
import {
  WorkwiseJob,
  WorkwiseEnquiry,
  WorkwiseSearchResponse,
  WorkwiseDescriptionPart,
} from './workwise.types';

/**
 * Workwise recruiting-platform careers scraper — generic, multi-tenant.
 *
 * Workwise (workwise.io, Karlsruhe, Germany — formerly "Campusjäger"; a German SMB
 * recruiting platform + ATS used by 2,000+ companies) gives each customer a branded,
 * public, candidate-facing career board on the shared host `https://{tenant}.workwise.io/`,
 * and a public per-role detail page on the main site
 * `https://www.workwise.io/job/{id}-{slug}` (server-rendered, anonymous, carrying a full
 * `enquiry` job object + a `JobPosting` JSON-LD block). A Workwise job is internally an
 * "enquiry"; the numeric `id` (e.g. `121910`) is the stable ATS id.
 *
 * The branded board renders its open-roles LIST client-side via the candidate jobs-search
 * API `POST https://api.workwise.io/v1/jobs/search` (filtered by the tenant's company id),
 * which is session-gated — it answers anonymous calls HTTP 405. There is therefore no clean
 * anonymous JSON list feed; the adapter attempts that search API defensively and degrades to
 * an empty result for an un-credentialed caller. The per-role mapping mirrors the confirmed
 * public detail shape so real roles map correctly the moment a list is obtainable (e.g.
 * behind a session-bearing proxy, or if Workwise later exposes an anonymous board feed).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g. `aifinyo`) or
 * by `companyUrl` (a career-site URL on a `workwise.io` host whose leading sub-domain label
 * is the tenant). An unknown tenant, one with no open roles, an empty board, an HTTP 4xx/5xx,
 * a DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.WORKWISE,
  name: 'Workwise',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WorkwiseService implements IScraper {
  private readonly logger = new Logger(WorkwiseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Workwise scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Workwise tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Workwise host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? WORKWISE_DEFAULT_TIMEOUT_SECONDS,
      WORKWISE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders({
      ...WORKWISE_HEADERS,
      // The candidate API answers CORS only for the tenant board origin; mirror it so a
      // session-bearing proxy is accepted.
      Origin: workwiseCareerOrigin(tenant),
      Referer: `${workwiseCareerOrigin(tenant)}/`,
    });

    const resultsWanted = input.resultsWanted ?? WORKWISE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Workwise jobs for tenant: ${tenant}`);

      const fallbackCompanyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the paginated candidate jobs-search up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure aborts the sweep; an HTTP error /
      // malformed page degrades to an empty / partial result.
      for (let page = 0; page < WORKWISE_MAX_PAGES; page++) {
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
              fallbackCompanyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Workwise role ${item?.id}: ${err.message}`);
          }
        }

        // Stop when the feed reports this is the last page (or omits the flag and returned a
        // short page).
        if (body.last === true) break;
        if (typeof body.totalPages === 'number' && page + 1 >= body.totalPages) break;
        if (items.length < WORKWISE_PAGE_SIZE) break;
      }

      this.logger.log(`Workwise total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Workwise scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * POST one page of the tenant's candidate jobs-search as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed search envelope, or null when the response carried no usable
   *    JSON / the host answered an HTTP error status (4xx / 5xx — including the 405 the
   *    session-gated API returns to anonymous callers — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the host itself is unreachable and the caller
   *    should stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ data: WorkwiseSearchResponse | null; hostReachable: boolean }> {
    const url = `${WORKWISE_API_ORIGIN}/${WORKWISE_JOBS_SEARCH_PATH}`;
    const payload = this.buildSearchPayload(tenant, page);
    try {
      const response = await client.post<WorkwiseSearchResponse | string>(url, payload);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (405 anonymous / 4xx unknown / 5xx) — it is
        // reachable, but there is nothing more to drain anonymously.
        this.logger.warn(`Workwise search returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Workwise search fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Build the candidate jobs-search request body. The board filters by the tenant's company
   * id; when the slug is non-numeric we fall back to a name term so the search can still
   * scope to the tenant. Modelled defensively across the keys the API accepts.
   */
  private buildSearchPayload(tenant: string, page: number): Record<string, unknown> {
    const companyId = this.numericTenant(tenant);
    const filters: Record<string, unknown> = {};
    if (companyId !== null) {
      filters.companyIds = [companyId];
    } else {
      // Non-numeric slug: scope by company name term + slug so the search still targets the
      // tenant rather than the global board.
      filters.companyName = this.deriveSlugName(tenant);
      filters.companySlug = tenant;
    }
    return {
      filters,
      query: '',
      page,
      size: WORKWISE_PAGE_SIZE,
    };
  }

  /**
   * Coerce an axios response body into a parsed search envelope. The client usually parses
   * the JSON for us (object body); if the host serves it as a text/plain string we parse it
   * ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(
    data: WorkwiseSearchResponse | string | unknown,
  ): WorkwiseSearchResponse | null {
    if (data && typeof data === 'object') return data as WorkwiseSearchResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as WorkwiseSearchResponse;
      } catch (err: any) {
        this.logger.warn(`Workwise search JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Narrow whichever roles-array key the envelope carries to an array. */
  private extractItems(body: WorkwiseSearchResponse): WorkwiseEnquiry[] {
    const candidate = body.content ?? body.results ?? body.items ?? body.data;
    return Array.isArray(candidate) ? candidate : [];
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: WorkwiseEnquiry,
    tenant: string,
    fallbackCompanyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, fallbackCompanyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised WorkwiseJob from a parsed role. */
  private normaliseItem(
    item: WorkwiseEnquiry,
    tenant: string,
    fallbackCompanyName: string,
  ): WorkwiseJob | null {
    const atsId = this.cleanText(item.id != null ? String(item.id) : null);
    if (!atsId) return null;

    const slug = this.cleanText(item.slug);
    const url = workwiseJobUrl(atsId, slug);

    const loc = Array.isArray(item.locationLevels) ? item.locationLevels[0] : null;
    const city = this.cleanText(loc?.city) ?? this.cleanText(item.company?.city);
    const state = this.cleanText(loc?.state) ?? this.cleanText(loc?.region);
    const country = this.cleanText(loc?.country) ?? this.cleanText(item.company?.country);
    const locationText = this.joinLocation(city, state, country);

    const title = this.cleanText(item.name) ?? this.cleanText(item.title);
    const department = this.cleanText(item.jobRole);
    const employmentType = this.mapEmploymentType(item);
    const companyName = this.cleanText(item.company?.name) ?? fallbackCompanyName;

    return {
      atsId,
      url,
      // The Workwise detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName,
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.extractDescription(item),
      department,
      employmentType,
      datePosted: this.parseDate(item.firstPublished ?? item.lastPublished ?? item.modified),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised WorkwiseJob → JobPostDto. */
  private processJob(
    job: WorkwiseJob,
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
      id: `workwise-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.WORKWISE,
      atsId,
      atsType: 'workwise',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Extract a role's description body. Workwise serves the body as `description` (HTML), or
   * as structured `descriptionParts[]` ({ title, content }); join the parts into a single
   * HTML body when the flat field is absent.
   */
  private extractDescription(item: WorkwiseEnquiry): string | null {
    const flat = this.cleanText(item.description);
    if (flat) return flat;
    const parts = Array.isArray(item.descriptionParts) ? item.descriptionParts : [];
    const joined = parts
      .map((p: WorkwiseDescriptionPart) => this.renderPart(p))
      .filter((s): s is string => !!s)
      .join('\n');
    const cleaned = this.cleanText(joined);
    return cleaned ?? this.cleanText(item.shortDescription);
  }

  /** Render a single description part as an HTML fragment. */
  private renderPart(part: WorkwiseDescriptionPart): string | null {
    const body = this.cleanText(part?.content) ?? this.cleanText(part?.text);
    if (!body) return null;
    const heading = this.cleanText(part?.title);
    return heading ? `<h3>${heading}</h3>${body}` : body;
  }

  /**
   * Convert the role description body per `descriptionFormat`. Workwise exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Map the role's employment-type token to a human label. Workwise emits schema.org-style
   * tokens (`FULL_TIME`, `PART_TIME`, `CONTRACTOR`, …) and internal tokens (`PERMANENT`);
   * unknown tokens are title-cased as a best-effort label.
   */
  private mapEmploymentType(item: WorkwiseEnquiry): string | null {
    const token = this.cleanText(item.employmentType) ?? this.cleanText(item.type);
    if (!token) return null;
    const upper = token.toUpperCase();
    const map: Record<string, string> = {
      FULL_TIME: 'Full Time',
      FULLTIME: 'Full Time',
      PART_TIME: 'Part Time',
      PARTTIME: 'Part Time',
      CONTRACTOR: 'Contract',
      CONTRACT: 'Contract',
      TEMPORARY: 'Temporary',
      INTERN: 'Internship',
      INTERNSHIP: 'Internship',
      PERMANENT: 'Permanent',
    };
    if (map[upper]) return map[upper];
    return token
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a `workwise.io`
   * host has the tenant taken from its leading sub-domain label. Returns an empty string
   * when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(WORKWISE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Workwise career-site URL. The candidate-facing board host
   * is `{tenant}.workwise.io`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(WORKWISE_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - WORKWISE_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / non-tenant infra label.
      if (!label || ['www', 'app', 'api', 'hire', 'hr', 'recruiting', 'static', 'img', 'bewerber'].includes(label)) {
        return '';
      }
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * The candidate search filters by the tenant's numeric company id. When the slug is itself
   * numeric (a caller passing the company id directly) we use it; otherwise null and the
   * payload falls back to a name/slug term.
   */
  private numericTenant(tenant: string): number | null {
    if (/^\d+$/.test(tenant)) {
      const n = Number(tenant);
      return Number.isFinite(n) ? n : null;
    }
    return null;
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
  private extractLocation(job: WorkwiseJob): LocationDto | null {
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

  /**
   * Detect remote roles from the structured `jobLocationTypes` / `remoteWork` signal, then
   * from the title, location, or department text.
   */
  private detectRemote(
    item: WorkwiseEnquiry,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    if (item.remoteWork === true) return true;
    const remoteString = typeof item.remoteWork === 'string' ? item.remoteWork : null;
    if (remoteString && WORKWISE_REMOTE_REGEX.test(remoteString)) return true;

    const types = Array.isArray(item.jobLocationTypes) ? item.jobLocationTypes : [];
    for (const t of types) {
      if (typeof t === 'string' && t.toLowerCase().includes(WORKWISE_REMOTE_TYPE)) return true;
    }

    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (WORKWISE_REMOTE_REGEX.test(field)) return true;
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

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
