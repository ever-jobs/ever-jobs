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
  TALENTERA_ROOT_DOMAIN,
  TALENTERA_HEADERS,
  TALENTERA_DEFAULT_RESULTS,
  TALENTERA_MAX_PAGES,
  TALENTERA_PAGE_SIZE,
  TALENTERA_DEFAULT_TIMEOUT_SECONDS,
  TALENTERA_SEARCH_ACTION,
  TALENTERA_SEARCH_BODY,
  TALENTERA_DEFAULT_LANG,
  TALENTERA_TOKEN_REGEX,
  TALENTERA_REMOTE_REGEX,
  talenteraResultsUrl,
  talenteraSearchUrl,
  talenteraJobDetailUrl,
  talenteraApplyUrl,
} from './talentera.constants';
import {
  TalenteraJob,
  TalenteraJobItem,
  TalenteraSearchResponse,
} from './talentera.types';

/**
 * Talentera ATS careers scraper — generic, multi-tenant.
 *
 * Talentera (talentera.com, by Bayt — a MENA-region talent-acquisition / applicant-tracking
 * platform) powers each customer's branded, public, unauthenticated candidate-facing career
 * portal on a per-tenant **sub-domain codename** of the shared root
 * (`https://{codename}.talentera.com/`). The candidate-facing board is a client-rendered (Vue)
 * SPA backed by a **public, anonymous JSON endpoint** the board itself consumes — the portal's
 * own job-search manager:
 *
 *   GET /app/control/byt_job_search_manager?action=1&token={t}&query={qs}&body=job-search-results&lan={lang}
 *     → { totalJobs, currentPage, view, jobs: [ { id, title, desc, … } ], cluster, totalVacancies }
 *
 * The board first loads the public `/en/job-search-results/` page, which embeds a short-lived
 * anonymous guest `USER_token` (no login — a visitor token the SPA echoes back on the search
 * call). The adapter mirrors that two-step exactly: GET the results page to mint the guest token
 * + session cookies, then GET the search manager with `action=1` and that token. The envelope
 * exposes `totalJobs`, so the adapter drains pages (bounded by `totalJobs` and a page cap),
 * mapping each role — rather than depending on a client-rendered DOM, a headless browser, or any
 * authenticated Talentera API. Each role's string `id` is the stable ATS id; the canonical
 * detail page is `/en/{country}/jobs/{slug}-{id}/` and the apply page is
 * `/en/job-application/?jb_id={id}`.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain codename, e.g. `careerroyaljet`)
 * or by `companyUrl` (any `{codename}.talentera.com` URL). An unknown codename, a tenant with no
 * open roles, an empty board, or the anti-automation guard (which answers
 * `{ status: 'fail', url: '…' }` when the guest token is rejected) all degrade naturally to an
 * empty result. A fetch error, an HTTP 4xx/5xx, a DNS failure, or a malformed body degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.TALENTERA,
  name: 'Talentera',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TalenteraService implements IScraper {
  private readonly logger = new Logger(TalenteraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Talentera scraper');
      return new JobResponseDto([]);
    }

    const codename = this.resolveCodename(companySlug, input.companyUrl);
    if (!codename) {
      this.logger.warn('Could not resolve a Talentera tenant codename from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Talentera host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? TALENTERA_DEFAULT_TIMEOUT_SECONDS,
      TALENTERA_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders({
      ...TALENTERA_HEADERS,
      Origin: `https://${codename}.${TALENTERA_ROOT_DOMAIN}`,
      Referer: talenteraResultsUrl(codename),
    });

    const resultsWanted = input.resultsWanted ?? TALENTERA_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Talentera jobs for codename: ${codename}`);

      // Step 1: load the public results page to mint the anonymous guest token + session
      // cookies the search manager requires.
      const token = await this.fetchGuestToken(client, codename);
      if (token === null) {
        // Host unreachable / results page missing — degrade to empty.
        this.logger.warn(`No Talentera guest token minted for ${codename}`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCodenameName(codename);
      const seen = new Set<string>();
      let totalJobs: number | null = null;

      // Step 2: drain the paginated public search manager. We stop when a page returns no
      // roles, when we have collected the reported `totalJobs`, when we hit the page cap, or
      // once `resultsWanted` roles are collected. A transport-level failure (host unreachable)
      // aborts the sweep; an HTTP error / malformed page / guard response degrades to an empty
      // / partial result.
      for (let page = 1; page <= TALENTERA_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, codename, token, page);
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / guard / unparseable body → stop draining

        if (totalJobs === null) {
          totalJobs = this.toInt(body.totalJobs);
        }

        const items = Array.isArray(body.jobs) ? body.jobs : [];
        if (items.length === 0) break; // past the last page / empty board

        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(
              item,
              codename,
              companyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Talentera role ${item?.id}: ${err.message}`);
          }
        }

        // Stop once we have walked past the reported total (when the host reports one).
        if (totalJobs !== null && page * TALENTERA_PAGE_SIZE >= totalJobs) break;
      }

      this.logger.log(`Talentera total: ${jobPosts.length} jobs for ${codename}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Talentera scrape error for ${codename}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET the tenant's public results board page and extract the anonymous guest `USER_token` the
   * SPA echoes back on the search manager. Returns:
   *  - the token string when minted,
   *  - an empty string when the page loaded but carried no token (still reachable — the search
   *    manager is attempted token-less, which the guard may still accept for some tenants),
   *  - null ONLY for a transport-level failure (host unreachable), where the caller should not
   *    attempt the search manager at all.
   * Never throws.
   */
  private async fetchGuestToken(
    client: ReturnType<typeof createHttpClient>,
    codename: string,
  ): Promise<string | null> {
    const url = talenteraResultsUrl(codename);
    try {
      const response = await client.get<string>(url, { responseType: 'text' } as any);
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const match = html.match(TALENTERA_TOKEN_REGEX);
      return match && match[1] ? match[1] : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status — it is reachable but the board is unavailable.
        this.logger.warn(`Talentera results page returned HTTP ${status} for ${codename}`);
        return null;
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
      this.logger.warn(`Talentera results page fetch failed for ${codename}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * GET one page of the public job-search manager as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed `{ totalJobs, jobs, … }` envelope, or null when the response carried
   *    no usable JSON, when the host answered an HTTP error status (4xx / 5xx — a real, reachable
   *    host), or when the anti-automation guard answered `{ status: 'fail', url }`.
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop draining
   *    further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    codename: string,
    token: string,
    page: number,
  ): Promise<{ data: TalenteraSearchResponse | null; hostReachable: boolean }> {
    const url = this.buildSearchUrl(codename, token, page);
    try {
      const response = await client.get<TalenteraSearchResponse | string>(url);
      const parsed = this.coerceSearch(response.data);
      // The guard answers a `{ status, url }` shape (no `jobs`) when the guest token is
      // rejected — treat it as a reachable-but-empty result so draining stops cleanly.
      if (parsed && this.isGuardResponse(parsed)) {
        this.logger.warn(
          `Talentera search guard for ${codename}: ${this.cleanText(parsed.status) ?? 'fail'}`,
        );
        return { data: null, hostReachable: true };
      }
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // more to drain.
        this.logger.warn(`Talentera search returned HTTP ${status} for ${codename}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure: the host is unreachable. Degrade gracefully
      // and signal host-down.
      this.logger.warn(`Talentera search fetch failed for ${codename}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /** True when the envelope is the anti-automation guard shape (`{ status: 'fail', url }`). */
  private isGuardResponse(env: TalenteraSearchResponse): boolean {
    const status = this.cleanText(env.status);
    if (status && status.toLowerCase() === 'fail') return true;
    // A `{ url }`-only body with no `jobs` array is also the guard / redirect shape.
    if (!Array.isArray(env.jobs) && this.cleanText(env.url)) return true;
    return false;
  }

  /**
   * Coerce an axios response body into a parsed search envelope. The client usually parses the
   * JSON for us (object body); a text/plain string body is parsed defensively. A non-object /
   * unparseable body yields null (degrade to no roles).
   */
  private coerceSearch(
    data: TalenteraSearchResponse | string | unknown,
  ): TalenteraSearchResponse | null {
    if (data && typeof data === 'object') return data as TalenteraSearchResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as TalenteraSearchResponse;
      } catch (err: any) {
        this.logger.warn(`Talentera JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: TalenteraJobItem,
    codename: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, codename, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, codename, format);
  }

  /** Build a normalised TalenteraJob from a parsed role. */
  private normaliseItem(
    item: TalenteraJobItem,
    codename: string,
    companyName: string,
  ): TalenteraJob | null {
    const atsId = this.cleanText(this.toStringId(item.id));
    if (!atsId) return null;

    const city = this.cleanText(item.city);
    const state = this.cleanText(item.state);
    const country = this.cleanText(item.country);
    const locationText =
      this.cleanText(item.location) ?? this.joinLocation(city, state, country);
    const department = this.cleanText(item.category) ?? this.cleanText(item.department);
    const employmentType = this.cleanText(item.type) ?? this.cleanText(item.job_type);
    const title = this.cleanText(item.title);

    // Prefer the card's explicit detail URL; otherwise derive one from the country segment +
    // title slug + id. The apply URL is always derivable from the id.
    const url = this.resolveDetailUrl(item, codename, atsId, country, title);

    return {
      atsId,
      url,
      applyUrl: talenteraApplyUrl(codename, atsId),
      title,
      companyName,
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.desc) ?? this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(
        item.date ?? item.postedDate ?? item.posted_date,
      ),
      isRemote: this.detectRemote(item, title, locationText, department, employmentType),
    };
  }

  /** Map a normalised TalenteraJob → JobPostDto. */
  private processJob(
    job: TalenteraJob,
    codename: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCodenameName(codename);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `talentera-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.TALENTERA,
      atsId,
      atsType: 'talentera',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Talentera exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the public detail URL for a role. Prefers the card's explicit `url` (absolutised
   * against the tenant origin when it is a path), then a derived `/en/{country}/jobs/{slug}-{id}/`
   * from the country segment + a title-derived slug, finally falling back to the apply URL when
   * neither yields a usable detail path.
   */
  private resolveDetailUrl(
    item: TalenteraJobItem,
    codename: string,
    atsId: string,
    country: string | null,
    title: string | null,
  ): string {
    const explicit = this.cleanText(item.url);
    if (explicit) {
      const absolute = this.absolutise(explicit, codename);
      if (absolute) return absolute;
    }
    const slug =
      this.cleanText(item.slug) ?? (title ? this.slugify(title) : null) ?? 'job';
    const countrySegment = this.slugify(country ?? 'international') || 'international';
    return talenteraJobDetailUrl(codename, countrySegment, slug, atsId);
  }

  /** Absolutise a board-relative path against the tenant origin; pass through absolute URLs. */
  private absolutise(value: string, codename: string): string | null {
    const v = value.trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    const origin = `https://${codename}.${TALENTERA_ROOT_DOMAIN}`;
    return v.startsWith('/') ? `${origin}${v}` : `${origin}/${v}`;
  }

  /**
   * Resolve the tenant codename. An explicit `companySlug` is used directly (a full portal URL
   * passed as the slug is reduced to its sub-domain codename); a `companyUrl` on a
   * `{codename}.talentera.com` host has the codename taken from its sub-domain. Returns an empty
   * string when neither yields a codename.
   */
  private resolveCodename(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(`.${TALENTERA_ROOT_DOMAIN}`)) {
        const fromUrl = this.codenameFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.codenameFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant codename from a Talentera portal URL. The candidate-facing portal is
   * `{codename}.talentera.com`; the codename is the left-most sub-domain label. The bare apex
   * (`talentera.com`) and the marketing `www` host carry no tenant codename.
   */
  private codenameFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(`.${TALENTERA_ROOT_DOMAIN}`)) return '';
      const labels = hostname.split('.');
      // `{codename}.talentera.com` → labels = [codename, talentera, com]
      if (labels.length < 3) return '';
      const codename = labels[0];
      if (!codename || codename === 'www') return '';
      return codename;
    } catch {
      // Malformed URL — no codename.
    }
    return '';
  }

  /** Assemble the public job-search manager URL for a codename, guest token, and page. */
  private buildSearchUrl(codename: string, token: string, page: number): string {
    // Mirror the board's own `getJobsInfo()` body: `action`, `token`, `query` (the board's
    // own query-string, here just the page + page-size window), `body`, and `lan`.
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(TALENTERA_PAGE_SIZE),
    }).toString();
    const params = new URLSearchParams({
      action: String(TALENTERA_SEARCH_ACTION),
      token,
      query,
      body: TALENTERA_SEARCH_BODY,
      lan: TALENTERA_DEFAULT_LANG,
    });
    return `${talenteraSearchUrl(codename)}?${params.toString()}`;
  }

  /** De-slugify + title-case the tenant codename into a display company name. */
  private deriveCodenameName(codename: string): string {
    const base = codename && codename.trim() ? codename.trim() : codename;
    return base
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: TalenteraJob): LocationDto | null {
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
   * Detect remote roles from a structured `remote` flag, then from the title, location,
   * category, or employment-type text.
   */
  private detectRemote(
    item: TalenteraJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
    employmentType: string | null | undefined,
  ): boolean {
    if (item.remote === true) return true;
    const haystacks: Array<string | null | undefined> = [
      title,
      location,
      department,
      employmentType,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (TALENTERA_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a date value into a YYYY-MM-DD string. Non-absolute / unparseable values yield null.
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

  /** Lower-case, hyphenate, and strip a free-text value into a URL-safe slug token. */
  private slugify(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Coerce a numeric-or-string id into a string, else null. */
  private toStringId(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return value;
    return null;
  }

  /** Coerce a numeric-or-string count into a finite integer, else null. */
  private toInt(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string') {
      const n = parseInt(value.trim(), 10);
      if (!isNaN(n)) return n;
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
