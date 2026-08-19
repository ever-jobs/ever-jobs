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
  GREETING_CAREER_HOST_SUFFIX,
  GREETING_ROOT_DOMAIN,
  GREETING_INDEX_PATHS,
  GREETING_LOCALES,
  GREETING_OPENING_PATH,
  GREETING_APPLY_PATH,
  GREETING_DEFAULT_RESULTS,
  GREETING_MAX_PAGES,
  GREETING_MAX_DETAIL_FETCHES,
  GREETING_DEFAULT_TIMEOUT_SECONDS,
  GREETING_HEADERS,
  GREETING_WORKSPACE_HEADER,
  GREETING_NEXT_DATA_REGEX,
  GREETING_REMOTE_REGEX,
  GREETING_EMPLOYMENT_TYPES,
  greetingCareerOrigin,
  greetingOpeningDetailPath,
} from './greeting.constants';
import {
  GreetingNextData,
  GreetingDehydratedQuery,
  GreetingOpening,
  GreetingJobPosition,
  GreetingJob,
  GreetingOpeningDetailResponse,
} from './greeting.types';

/**
 * Greeting ATS careers scraper — generic, multi-tenant.
 *
 * Greeting (greetinghr.com, by Dudaji — South Korea) is a Korean recruitment / HR ATS
 * that powers each customer's branded, public, unauthenticated candidate-facing career
 * site on the shared host `https://{tenant}.career.greetinghr.com/`. The landing page is a
 * Next.js shell that embeds the full set of open roles directly in the HTML inside the
 * standard `__NEXT_DATA__` script tag as a React-Query "dehydrated state" — a list of
 * pre-fetched queries. One query (queryKey `["openings"]`) carries the full open-roles
 * array; another (`getCareerBootInfo`) carries the tenant `workspaceId`.
 *
 * The adapter extracts that embedded `__NEXT_DATA__` JSON and reads those queries — rather
 * than depending on a client-rendered DOM or a headless browser. Each opening's
 * `openingId` is the stable ATS id and the final segment of the canonical detail URL
 * `/{locale}/o/{openingId}` and apply URL `/{locale}/o/{openingId}/apply`. The richer HTML
 * job-ad body is then enriched (best-effort) from the public detail API
 * `GET https://api.greetinghr.com/ats/v3.5/career/workspaces/{workspaceId}/openings/{openingId}`.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `ablelabs`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no open
 * roles, or an empty board degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx, a DNS failure, or a malformed body degrades to an empty / partial result rather
 * than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.GREETING,
  name: 'Greeting',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GreetingService implements IScraper {
  private readonly logger = new Logger(GreetingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Greeting scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Greeting tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Greeting career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? GREETING_DEFAULT_TIMEOUT_SECONDS,
      GREETING_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(GREETING_HEADERS);

    const resultsWanted = input.resultsWanted ?? GREETING_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Greeting jobs for tenant: ${tenant}`);

      const found = await this.fetchOpenings(client, tenant);
      if (!found) {
        this.logger.log(`Greeting tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { openings, locale, workspaceId } = found;
      if (openings.length === 0) {
        this.logger.log(`Greeting tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      let detailFetches = 0;
      for (const opening of openings) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const job = this.normaliseOpening(opening, tenant, locale);
          if (!job) continue;
          if (seen.has(job.atsId)) continue;
          seen.add(job.atsId);

          // Best-effort: enrich the role with its HTML job-ad body from the detail API.
          // Bounded by GREETING_MAX_DETAIL_FETCHES so a large board never blows the CI
          // budget; a role with no enriched body still surfaces (title/location/links).
          if (
            !job.descriptionHtml &&
            workspaceId &&
            detailFetches < GREETING_MAX_DETAIL_FETCHES
          ) {
            detailFetches++;
            const detail = await this.fetchOpeningDetail(client, workspaceId, job.atsId);
            if (detail) {
              if (detail.descriptionHtml) job.descriptionHtml = detail.descriptionHtml;
              if (!job.companyName && detail.companyName) job.companyName = detail.companyName;
              if (!job.title && detail.title) job.title = detail.title;
            }
          }

          const post = this.processJob(job, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Greeting role ${opening?.openingId}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Greeting total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Greeting scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's candidate-facing landing across the known locale/path variants
   * until one returns an embedded openings query. Returns the parsed openings, the locale
   * that served them (used to build per-role URLs), and the tenant `workspaceId` (used for
   * detail-API enrichment), or null when none respond.
   */
  private async fetchOpenings(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ openings: GreetingOpening[]; locale: string; workspaceId: string | null } | null> {
    const origin = greetingCareerOrigin(tenant);
    let attempts = 0;

    for (const locale of GREETING_LOCALES) {
      for (const path of GREETING_INDEX_PATHS) {
        if (attempts >= GREETING_MAX_PAGES) return null;
        attempts++;

        const segment = [locale, path].filter((p) => p).join('/');
        const url = segment ? `${origin}/${segment}` : `${origin}/`;
        const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
        // A transport-level failure (DNS / refused / reset / timeout) means the tenant
        // host itself is unreachable — no other locale/path can succeed, so abort the
        // whole probe sweep rather than burning a full timeout per combo.
        if (!hostReachable) return null;
        if (html == null) continue;

        const nextData = this.extractNextData(html);
        if (nextData == null) continue; // no __NEXT_DATA__ on this page — try next

        const openings = this.extractOpenings(nextData);
        if (openings == null) continue; // no openings query — try next path/locale

        const workspaceId = this.extractWorkspaceId(nextData);
        // The landing renders the openings query — return it (possibly empty; an empty
        // board is a valid "no roles" result).
        return { openings, locale: this.resolveLocale(locale, url), workspaceId };
      }
    }

    return null;
  }

  /**
   * GET a career-site URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop probing further locale/path combinations.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      // The tenant root 301-redirects to a localised landing (e.g. `/ko/home`), so DO
      // follow redirects here (unlike a board that serves a direct 200). The redirect
      // stays on the tenant career host and resolves the embedded `__NEXT_DATA__`.
      const response = await client.get<string>(url, { responseType: 'text' });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx path-not-found or 5xx) — it is reachable,
        // so the caller may still try other locale/path combinations.
        this.logger.warn(`Greeting board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Greeting board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Fetch one role's HTML job-ad body (and group name / title) from the public detail
   * API. Never throws — any failure yields null and the role surfaces without the
   * enriched body.
   */
  private async fetchOpeningDetail(
    client: ReturnType<typeof createHttpClient>,
    workspaceId: string,
    openingId: string,
  ): Promise<{ descriptionHtml: string | null; companyName: string | null; title: string | null } | null> {
    const url = greetingOpeningDetailPath(workspaceId, openingId);
    try {
      const response = await client.get<GreetingOpeningDetailResponse>(url, {
        headers: {
          Accept: 'application/json',
          [GREETING_WORKSPACE_HEADER]: workspaceId,
        },
      });
      const body = response?.data;
      if (!body || body.success === false || !body.data) return null;
      const info = body.data.openingsInfo;
      return {
        descriptionHtml: this.cleanText(info?.detail),
        companyName: this.cleanText(body.data.groupInfo?.name),
        title: this.cleanText(info?.title),
      };
    } catch (err: any) {
      this.logger.warn(
        `Greeting detail fetch failed for opening ${openingId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Extract and parse the JSON embedded in the Next.js `__NEXT_DATA__` script tag.
   * Returns the parsed envelope, or null when the marker is absent / unparseable (so the
   * caller tries another path).
   */
  private extractNextData(html: string): GreetingNextData | null {
    GREETING_NEXT_DATA_REGEX.lastIndex = 0;
    const match = GREETING_NEXT_DATA_REGEX.exec(html);
    if (!match || !match[1]) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return parsed && typeof parsed === 'object' ? (parsed as GreetingNextData) : null;
    } catch (err: any) {
      this.logger.warn(`Greeting __NEXT_DATA__ JSON parse failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Read the openings array out of the dehydrated React-Query state. The list lives in
   * the query whose key is `["openings"]` and whose `state.data` is the array. Returns:
   *  - the openings array (possibly empty) when the openings query is present
   *  - `null` when no openings query is found (so the caller tries another path)
   */
  private extractOpenings(nextData: GreetingNextData): GreetingOpening[] | null {
    const queries = this.dehydratedQueries(nextData);
    if (!queries) return null;

    for (const query of queries) {
      if (!this.queryKeyMatches(query?.queryKey, 'openings')) continue;
      const data = query?.state?.data;
      if (Array.isArray(data)) return data as GreetingOpening[];
      // Some shells wrap the array under a `data` / `content` key; narrow defensively.
      if (data && Array.isArray((data as { data?: unknown }).data)) {
        return (data as { data: GreetingOpening[] }).data;
      }
      if (data && Array.isArray((data as { content?: unknown }).content)) {
        return (data as { content: GreetingOpening[] }).content;
      }
      return []; // openings query present but no usable array → empty board
    }
    return null;
  }

  /**
   * Read the tenant `workspaceId` out of the dehydrated state. It is carried as the third
   * element of the `getCareerBootInfo` query key (`{ workspaceId }`). Falls back to any
   * query key whose object element exposes a `workspaceId`. Returns null when absent.
   */
  private extractWorkspaceId(nextData: GreetingNextData): string | null {
    const queries = this.dehydratedQueries(nextData);
    if (!queries) return null;

    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key)) continue;
      for (const part of key) {
        if (part && typeof part === 'object') {
          const ws = (part as { workspaceId?: unknown }).workspaceId;
          if (typeof ws === 'number' && Number.isFinite(ws)) return String(ws);
          const wsText = this.cleanText(typeof ws === 'string' ? ws : null);
          if (wsText) return wsText;
        }
      }
    }
    return null;
  }

  /** Safely read the dehydrated query list from the parsed `__NEXT_DATA__` envelope. */
  private dehydratedQueries(nextData: GreetingNextData): GreetingDehydratedQuery[] | null {
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
    return Array.isArray(queries) ? queries : null;
  }

  /** True when a React-Query key's first element equals the given marker string. */
  private queryKeyMatches(queryKey: unknown, marker: string): boolean {
    if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
    return queryKey[0] === marker;
  }

  /** Build a normalised GreetingJob from a parsed opening. */
  private normaliseOpening(
    opening: GreetingOpening,
    tenant: string,
    locale: string,
  ): GreetingJob | null {
    // Only surface deployed (publicly visible) roles; a non-deployed flag means the role
    // is hidden on the board. `deploy` is optional — treat absent as visible.
    if (opening?.deploy === false) return null;

    const atsId = this.numToText(opening?.openingId);
    if (!atsId) return null;

    const title = this.cleanText(opening?.title);
    const position = this.pickPosition(opening);

    const url = this.buildOpeningUrl(tenant, locale, atsId);
    const applyUrl = this.buildApplyUrl(tenant, locale, atsId);

    const place = position?.workspacePlace;
    const locationText =
      this.cleanText(place?.place) ?? this.cleanText(place?.location);
    const { city, state, country } = this.splitLocation(locationText);

    const department = this.cleanText(position?.workspaceOccupation?.occupation);
    const employmentType = this.mapEmploymentType(
      position?.jobPositionEmployment?.employmentType,
    );
    const workFromHome = place?.workFromHome === true;

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: this.cleanText(opening?.group?.name) ?? this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: null, // enriched later from the detail API
      department,
      employmentType,
      datePosted: this.parseDate(opening?.openDate),
      isRemote: workFromHome || this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised GreetingJob → JobPostDto. */
  private processJob(
    job: GreetingJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `greeting-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.GREETING,
      atsId,
      atsType: 'greeting',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Pick the best job position from an opening: the first position that carries any of a
   * place, occupation, or employment type, falling back to the first entry.
   */
  private pickPosition(opening: GreetingOpening): GreetingJobPosition | null {
    const positions = opening?.openingJobPosition?.openingJobPositions;
    if (!Array.isArray(positions) || positions.length === 0) return null;
    const rich = positions.find(
      (p) => p?.workspacePlace || p?.workspaceOccupation || p?.jobPositionEmployment,
    );
    return rich ?? positions[0] ?? null;
  }

  /** Map a Greeting `employmentType` enum token to a human-readable label, or null. */
  private mapEmploymentType(value: string | null | undefined): string | null {
    const token = this.cleanText(value);
    if (!token) return null;
    return GREETING_EMPLOYMENT_TYPES[token] ?? null;
  }

  /**
   * Convert the HTML job-ad body per `descriptionFormat`. The body is HTML, so HTML
   * returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * career-site URL passed as the slug is reduced to its tenant token); a `companyUrl` on
   * a `career.greetinghr.com` host has the tenant taken from its leading sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(GREETING_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Greeting career-site URL. The candidate-facing host is
   * `{tenant}.career.greetinghr.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(GREETING_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - GREETING_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` label.
      if (!label || label === 'www') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Resolve the locale segment used to build per-role URLs. When the probe used an
   * explicit locale, use it; otherwise (default-locale redirect) recover the locale from
   * the resolved landing URL's first path segment, defaulting to `ko` (the home locale).
   */
  private resolveLocale(probeLocale: string, resolvedUrl: string): string {
    if (probeLocale) return probeLocale;
    try {
      const u = new URL(resolvedUrl);
      const first = u.pathname.split('/').filter((s) => s)[0];
      if (first && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(first)) return first.toLowerCase();
    } catch {
      // ignore
    }
    return 'ko';
  }

  /** Build the canonical public detail URL for a role: `/{locale}/o/{openingId}`. */
  private buildOpeningUrl(tenant: string, locale: string, atsId: string): string {
    const origin = greetingCareerOrigin(tenant);
    const localePrefix = locale ? `${locale}/` : '';
    return `${origin}/${localePrefix}${GREETING_OPENING_PATH}/${encodeURIComponent(atsId)}`;
  }

  /** Build the canonical public apply URL: `/{locale}/o/{openingId}/apply`. */
  private buildApplyUrl(tenant: string, locale: string, atsId: string): string {
    return `${this.buildOpeningUrl(tenant, locale, atsId)}/${GREETING_APPLY_PATH}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: GreetingJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text place line into city / state / country. A
   * Greeting `place` is typically a full Korean address; the leading token is commonly the
   * country ("대한민국" / "South Korea"). When the leading token is a country marker it is
   * surfaced as the country and the remainder as the city; otherwise the whole value lands
   * in `city`.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(/[,\s]+/)
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };

    const head = parts[0];
    if (this.isCountryToken(head)) {
      const rest = parts.slice(1).join(' ');
      return { city: rest || null, state: null, country: head };
    }
    return { city: text, state: null, country: null };
  }

  /** True when a token is a recognised country marker (Korean / English). */
  private isCountryToken(value: string): boolean {
    return /^(대한민국|한국|south\s*korea|korea|republic\s+of\s+korea)$/i.test(value.trim());
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
      if (GREETING_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|재택|원격)$/i.test(value.trim());
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

  /** Coerce a numeric / string id field into trimmed text, or null when empty. */
  private numToText(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
