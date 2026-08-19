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
  BEAMERY_ROOT_DOMAIN,
  BEAMERY_CAREER_HOST_SUFFIX,
  BEAMERY_JOBS_PATH,
  BEAMERY_JOB_PATH_PREFIX,
  BEAMERY_PAGE_SIZE,
  BEAMERY_DEFAULT_RESULTS,
  BEAMERY_MAX_PAGES,
  BEAMERY_DEFAULT_TIMEOUT_SECONDS,
  BEAMERY_HEADERS,
  BEAMERY_REMOTE_TYPE,
  BEAMERY_REMOTE_REGEX,
  beameryCareerOrigin,
} from './beamery.constants';
import {
  BeameryJob,
  BeameryJobItem,
  BeameryJobsResponse,
  BeameryLocation,
} from './beamery.types';

/**
 * Beamery careers / talent-CRM scraper — generic, multi-tenant.
 *
 * Beamery (beamery.com, London, UK — an enterprise Talent Lifecycle Management / talent-CRM +
 * career-site platform) powers each customer's branded, public, unauthenticated candidate-facing
 * career site on the shared `beamery.com` domain (Beamery's own at `careers.beamery.com`,
 * branded tenant portals at `{tenant}.beamery.com`, flows at `flows.beamery.com/{tenant}`), or a
 * custom vanity domain backed by `vanity.beamery.com`. The per-role public detail page follows a
 * confirmed, stable pattern: `https://{host}/jobs/job/{uuid}-{title-slug}/`.
 *
 * Unlike a clean JSON-feed ATS, the Beamery careers site is **server-rendered** and exposes no
 * confirmed anonymous JSON jobs feed (the candidate-facing `/api/...` routes are gated and the
 * only structured API is the authenticated `frontier.beamery.com` REST API requiring a bearer
 * token). This adapter is therefore DEFENSIVE: it probes a best-effort candidate-facing JSON
 * route on the tenant host, parses any role array under the common keys (`data` / `results` /
 * `jobs` / `vacancies` / `items` or a bare array), and degrades to an EMPTY result when no
 * anonymous JSON is served — rather than scraping a brittle SSR DOM or driving a headless
 * browser. It NEVER throws, so a gated / SSR-only / unknown tenant never nukes a batch run.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g. `careers` or a
 * branded label such as `amazon`) or by `companyUrl` (a career-site URL on a `beamery.com` host
 * whose leading sub-domain label is the tenant). An unknown tenant, one with no open roles, an
 * SSR-only board, or a malformed body degrades naturally to an empty / partial result.
 */
@SourcePlugin({
  site: Site.BEAMERY,
  name: 'Beamery',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BeameryService implements IScraper {
  private readonly logger = new Logger(BeameryService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Beamery scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Beamery tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Beamery career host degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy
    // path keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? BEAMERY_DEFAULT_TIMEOUT_SECONDS,
      BEAMERY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(BEAMERY_HEADERS);

    const resultsWanted = input.resultsWanted ?? BEAMERY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Beamery jobs for tenant: ${tenant}`);

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the best-effort paginated JSON route up to the page cap or until we've
      // collected `resultsWanted` roles. A transport-level failure (host unreachable) aborts
      // the sweep; an HTTP error / SSR-only / malformed page degrades to an empty / partial
      // result.
      for (let page = 1; page <= BEAMERY_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, tenant, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / SSR-only / unparseable body → stop draining

        const items = this.extractItems(body);
        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Beamery role ${this.pickId(item)}: ${err.message}`);
          }
        }

        // Stop when the feed reports no further page (or omits the flag — single page).
        if (!this.hasNextPage(body)) break;
      }

      this.logger.log(`Beamery total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Beamery scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the tenant's best-effort jobs JSON route. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed envelope, or null when the response carried no usable JSON (an
   *    SSR-only HTML body, a gated route, or an HTTP error status — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the tenant host itself is unreachable and the caller should stop
   *    draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ data: BeameryJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(tenant, page);
    try {
      const response = await client.get<BeameryJobsResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx gated / unknown / 5xx) — it is reachable, but
        // there is nothing more to drain.
        this.logger.warn(`Beamery feed returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Beamery feed fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses the
   * JSON for us (object body); if a tenant serves a text/plain JSON string we parse it
   * ourselves. A server-rendered HTML body, a non-object, or an unparseable body yields null
   * (degrade to no roles) — this is the expected path for Beamery's SSR-only careers sites.
   */
  private coerceBody(data: BeameryJobsResponse | string | unknown): BeameryJobsResponse | null {
    if (Array.isArray(data)) {
      // A bare top-level role array — wrap it so `extractItems` finds it.
      return { data: data as BeameryJobItem[] };
    }
    if (data && typeof data === 'object') return data as BeameryJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed || trimmed.startsWith('<')) return null; // empty or an HTML (SSR) body
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return { data: parsed as BeameryJobItem[] };
        if (parsed && typeof parsed === 'object') return parsed as BeameryJobsResponse;
      } catch (err: any) {
        this.logger.warn(`Beamery feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Extract the role array from the envelope, tolerating the common Beamery-style keys
   * (`data` / `results` / `jobs` / `vacancies` / `items`). Returns [] when none carries an
   * array.
   */
  private extractItems(body: BeameryJobsResponse): BeameryJobItem[] {
    const candidates = [body.data, body.results, body.jobs, body.vacancies, body.items];
    for (const c of candidates) {
      if (Array.isArray(c)) return c;
    }
    return [];
  }

  /** Decide whether to drain another page, tolerating the common pagination spellings. */
  private hasNextPage(body: BeameryJobsResponse): boolean {
    const meta = body.meta;
    if (!meta) return false;
    return meta.hasNextPage === true || meta.hasMore === true;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: BeameryJobItem,
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

  /** Build a normalised BeameryJob from a parsed role. */
  private normaliseItem(
    item: BeameryJobItem,
    tenant: string,
    companyName: string,
  ): BeameryJob | null {
    const atsId = this.pickId(item);
    if (!atsId) return null;

    const title = this.cleanText(item.title) ?? this.cleanText(item.name);

    // Prefer a feed-supplied canonical URL; otherwise derive the confirmed public detail
    // pattern `{origin}/jobs/job/{uuid}-{slug}/`.
    const feedUrl = this.cleanText(item.url) ?? this.cleanText(item.jobUrl);
    const url = feedUrl ?? this.buildJobUrl(tenant, atsId, item.slug ?? title);
    const applyUrl = this.cleanText(item.applyUrl) ?? url;

    const loc = this.resolveLocation(item);
    const locationText = this.joinLocation(loc.city, loc.state, loc.country) ?? loc.text;
    const department =
      this.cleanText(item.department?.name) ??
      this.cleanText(item.departmentName) ??
      this.cleanText(item.team);
    const employmentType =
      this.cleanText(item.employmentType) ??
      this.cleanText(item.jobType) ??
      this.cleanText(item.type);

    return {
      atsId,
      url,
      // The Beamery detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself unless the feed supplies a distinct one.
      applyUrl,
      title,
      companyName: companyName || this.deriveSlugName(tenant),
      city: loc.city,
      state: loc.state,
      country: loc.country,
      locationText,
      descriptionHtml:
        this.cleanText(item.description) ??
        this.cleanText(item.descriptionHtml) ??
        this.cleanText(item.descriptionText),
      department,
      employmentType,
      datePosted: this.parseDate(
        item.publishedDate ?? item.publishedAt ?? item.postedDate ?? item.createdAt,
      ),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised BeameryJob → JobPostDto. */
  private processJob(
    job: BeameryJob,
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
      id: `beamery-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.BEAMERY,
      atsId,
      atsType: 'beamery',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Beamery exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /** Pick the stable role id across the common spellings (`id` / `uuid` / `jobId`). */
  private pickId(item: BeameryJobItem): string | null {
    return (
      this.cleanText(item.id) ?? this.cleanText(item.uuid) ?? this.cleanText(item.jobId)
    );
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a `beamery.com`
   * host has the tenant taken from its leading sub-domain label. Returns an empty string when
   * neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(BEAMERY_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Beamery career-site URL. The candidate-facing host is
   * `{tenant}.beamery.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(BEAMERY_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host (e.g. a custom vanity domain) — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - BEAMERY_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `app` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'app' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Assemble a tenant's best-effort jobs-feed URL for a given page. */
  private buildFeedUrl(tenant: string, page: number): string {
    const origin = beameryCareerOrigin(tenant);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(BEAMERY_PAGE_SIZE),
    });
    return `${origin}/${BEAMERY_JOBS_PATH}?${params.toString()}`;
  }

  /**
   * Assemble the confirmed public detail URL `{origin}/jobs/job/{uuid}-{slug}/` for a role.
   * Used when the feed omits a canonical URL. The slug is derived from the supplied slug /
   * title; when neither is usable the UUID alone keys the page.
   */
  private buildJobUrl(tenant: string, atsId: string, slugSource: string | null | undefined): string {
    const origin = beameryCareerOrigin(tenant);
    const slug = this.slugify(slugSource);
    const tail = slug ? `${atsId}-${slug}` : atsId;
    return `${origin}/${BEAMERY_JOB_PATH_PREFIX}/${tail}/`;
  }

  /** Lower-case, hyphenate a title/slug source into a URL-safe slug; null when unusable. */
  private slugify(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const slug = cleaned
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : null;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Resolve a role's location into structured parts + a free-text line, tolerating the flat
   * `location` string, a `locationObject` block, and a `locations[]` array.
   */
  private resolveLocation(item: BeameryJobItem): {
    city: string | null;
    state: string | null;
    country: string | null;
    text: string | null;
  } {
    const flat = this.cleanText(item.location);
    const block: BeameryLocation | null =
      item.locationObject ?? (Array.isArray(item.locations) ? item.locations[0] ?? null : null);

    const city = this.cleanText(block?.city) ?? this.cleanText(block?.name) ?? flat;
    const state = this.cleanText(block?.region) ?? this.cleanText(block?.state);
    const country = this.cleanText(block?.country) ?? this.cleanText(block?.countryCode);
    const text = flat ?? this.cleanText(block?.name);

    return { city, state, country, text };
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: BeameryJob): LocationDto | null {
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
   * Detect remote roles from a structured remote flag, then from the title, location, or
   * department text.
   */
  private detectRemote(
    item: BeameryJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    if (item.remote === true) return true;
    if (item.locationObject?.remote === true) return true;
    if (Array.isArray(item.locations) && item.locations.some((l) => l?.remote === true)) {
      return true;
    }
    const typeToken =
      this.cleanText(item.employmentType) ??
      this.cleanText(item.jobType) ??
      this.cleanText(item.type);
    if (typeToken && typeToken.toLowerCase().includes(BEAMERY_REMOTE_TYPE)) return true;

    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (BEAMERY_REMOTE_REGEX.test(field)) return true;
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
