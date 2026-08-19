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
  BEESITE_ROOT_DOMAIN,
  beesiteHostedOrigin,
  BEESITE_INDEX_PATH,
  BEESITE_SEARCH_ACTION,
  BEESITE_JOBAD_ACTION,
  BEESITE_APPLY_ACTION,
  BEESITE_API_PATHS,
  BEESITE_DEFAULT_RESULTS,
  BEESITE_PAGE_SIZE,
  BEESITE_MAX_PAGES,
  BEESITE_DEFAULT_TIMEOUT_SECONDS,
  BEESITE_HEADERS,
  BEESITE_LANGUAGES,
  BEESITE_JOBAD_LINK_REGEX,
  BEESITE_RESULT_BOX_REGEX,
  BEESITE_REMOTE_REGEX,
} from './beesite.constants';
import {
  BeeSiteApiResponse,
  BeeSiteSearchResultItem,
  BeeSiteMatchedObjectDescriptor,
  BeeSitePositionLocation,
  BeeSiteFormattedContent,
  BeeSiteListRow,
  BeeSiteJob,
} from './beesite.types';

/**
 * BeeSite ATS careers scraper — generic, multi-tenant.
 *
 * BeeSite (beesite.de) is the enterprise recruiting suite by milch & zucker, used by
 * large DACH employers. Each customer runs a branded, public, unauthenticated career
 * portal — hosted at `https://{slug}.beesite.de/` or mounted at `/cust/beesite/` on the
 * customer's own domain — driven by a PHP front controller addressed via an `ac` action
 * parameter (`?ac=start`, `?ac=search_result`, `?ac=jobad&id={PositionID}`).
 *
 * The adapter ingests a tenant's open roles from two public surfaces, probed in order:
 *
 *  1. **JobBoardApi (JSON, preferred).** A JSON job board (`/search/?data={…}`) returns
 *     the open positions in the HR-XML `MatchedObjectDescriptor` envelope. The adapter
 *     reads each `SearchResultItems[].MatchedObjectDescriptor` — `PositionID`,
 *     `PositionTitle`, `PositionURI`, `PositionLocation`, `OrganizationName`,
 *     `PublicationStartDate`, `PositionFormattedDescription` — paging via
 *     `FirstItem` / `CountItem`.
 *  2. **Server-rendered list (HTML, fallback).** When the JSON API is not exposed, the
 *     `?ac=search_result` page renders each role in a `SearchResultBox` row linking to
 *     `?ac=jobad&id={PositionID}`. The adapter anchors on those links + row text.
 *
 * The BeeSite `PositionID` (the `id` of the `?ac=jobad&id=` detail URL) is the stable
 * ATS id; the canonical detail / apply URLs are built from it. The caller addresses a
 * tenant by `companySlug` (expanded to `{slug}.beesite.de`) or by `companyUrl` (any
 * BeeSite portal URL, hosted or custom-domain — the origin is honoured as-is). An
 * unknown tenant, a disabled API, an empty board, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a
 * single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.BEESITE,
  name: 'BeeSite',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BeeSiteService implements IScraper {
  private readonly logger = new Logger(BeeSiteService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for BeeSite scraper');
      return new JobResponseDto([]);
    }

    const origin = this.resolveOrigin(companySlug, input.companyUrl);
    if (!origin) {
      this.logger.warn('Could not resolve a BeeSite portal origin from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive BeeSite portal degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the
    // no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap the upper end.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? BEESITE_DEFAULT_TIMEOUT_SECONDS,
      BEESITE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(BEESITE_HEADERS);

    const resultsWanted = input.resultsWanted ?? BEESITE_DEFAULT_RESULTS;
    const tenantLabel = this.deriveTenantLabel(origin);
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching BeeSite jobs for portal: ${origin}`);

      const jobs = await this.fetchJobs(client, origin, resultsWanted);
      if (jobs.length === 0) {
        this.logger.log(`BeeSite portal "${origin}" has no reachable open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        if (seen.has(job.atsId)) continue; // dedupe by ATS id
        seen.add(job.atsId);
        try {
          const post = this.processJob(job, tenantLabel, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing BeeSite role ${job.atsId}: ${err.message}`);
        }
      }

      this.logger.log(`BeeSite total: ${jobPosts.length} jobs for ${origin}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`BeeSite scrape error for ${origin}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Collect the tenant's open roles, preferring the JobBoardApi JSON surface and
   * falling back to the server-rendered search list. Returns normalised BeeSiteJob
   * records (possibly empty). Never throws.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    resultsWanted: number,
  ): Promise<BeeSiteJob[]> {
    const fromApi = await this.fetchFromApi(client, origin, resultsWanted);
    if (fromApi.length > 0) {
      this.logger.log(`BeeSite JobBoardApi yielded ${fromApi.length} roles for ${origin}`);
      return fromApi;
    }

    const fromHtml = await this.fetchFromSearchHtml(client, origin, resultsWanted);
    if (fromHtml.length > 0) {
      this.logger.log(`BeeSite search list yielded ${fromHtml.length} roles for ${origin}`);
    }
    return fromHtml;
  }

  /**
   * Probe the JobBoardApi JSON endpoints (× languages), paging via `FirstItem` /
   * `CountItem` until the role set is exhausted or `resultsWanted` is reached. A
   * transport-level failure on the first request aborts that endpoint; a 4xx / 5xx /
   * non-JSON body skips it. Returns the normalised roles from the first endpoint+
   * language that yields any.
   */
  private async fetchFromApi(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    resultsWanted: number,
  ): Promise<BeeSiteJob[]> {
    for (const apiPath of BEESITE_API_PATHS) {
      for (const language of BEESITE_LANGUAGES) {
        const collected: BeeSiteJob[] = [];
        const seen = new Set<string>();
        let firstItem = 1;

        for (let page = 0; page < BEESITE_MAX_PAGES; page++) {
          const url = this.buildApiUrl(origin, apiPath, language, firstItem);
          const { data, hostReachable } = await this.fetchText(client, url, origin);
          // A transport-level failure means the portal host is unreachable — no other
          // endpoint/language can succeed, so abort the whole API probe.
          if (!hostReachable) return [];
          if (data == null) break; // HTTP error / empty — try the next endpoint/language

          const items = this.parseApiItems(data);
          if (items == null) break; // not a JSON board envelope — try the next surface
          if (items.length === 0) break; // valid empty page — done with this endpoint

          let added = 0;
          for (const item of items) {
            const job = this.normaliseApiItem(item, origin);
            if (!job) continue;
            if (seen.has(job.atsId)) continue;
            seen.add(job.atsId);
            collected.push(job);
            added++;
            if (collected.length >= resultsWanted) return collected;
          }

          // Stop the page walk once a page yields no new roles, or a short page signals
          // the final page.
          if (added === 0 || items.length < BEESITE_PAGE_SIZE) break;
          firstItem += BEESITE_PAGE_SIZE;
        }

        if (collected.length > 0) return collected;
      }
    }
    return [];
  }

  /**
   * Fetch + parse the server-rendered `?ac=search_result` HTML list. Anchors on every
   * `?ac=jobad&id={PositionID}` link, scoping each role's title / location to its
   * surrounding `SearchResultBox` row when present. Returns the normalised roles.
   */
  private async fetchFromSearchHtml(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    resultsWanted: number,
  ): Promise<BeeSiteJob[]> {
    const url = `${origin}/${BEESITE_INDEX_PATH}?ac=${BEESITE_SEARCH_ACTION}`;
    const { data: html, hostReachable } = await this.fetchText(client, url, origin);
    if (!hostReachable || html == null) return [];

    const rows = this.parseSearchHtml(html, origin);
    const out: BeeSiteJob[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const job = this.normaliseListRow(row, origin);
      if (!job) continue;
      if (seen.has(job.atsId)) continue;
      seen.add(job.atsId);
      out.push(job);
      if (out.length >= resultsWanted) break;
    }
    return out;
  }

  /** Build a JobBoardApi JSON request URL with the documented `data` query envelope. */
  private buildApiUrl(origin: string, apiPath: string, language: string, firstItem: number): string {
    const payload = {
      LanguageCode: language,
      SearchParameters: {
        FirstItem: firstItem,
        CountItem: BEESITE_PAGE_SIZE,
        Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }],
      },
      SearchCriteria: [] as unknown[],
    };
    return `${origin}/${apiPath}?data=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  /**
   * GET a URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the portal host itself is unreachable and the
   *    caller should stop probing further endpoints.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    origin: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx path-not-found / 5xx) — it is reachable,
        // so the caller may still try other endpoints / the HTML fallback.
        this.logger.warn(`BeeSite portal returned HTTP ${status} for ${origin}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure: the host is unreachable.
      this.logger.warn(`BeeSite portal fetch failed for ${origin}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Parse a JobBoardApi JSON body into its `SearchResultItems` array. Returns:
   *  - the items array (possibly empty) when the body is the JSON board envelope
   *  - `null` when the body is not parseable JSON / not the board envelope (so the
   *    caller falls through to the server-rendered HTML surface)
   */
  private parseApiItems(body: string): BeeSiteSearchResultItem[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null; // not JSON — likely the HTML portal shell
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const result = (parsed as BeeSiteApiResponse).SearchResult;
    if (!result || typeof result !== 'object') return null;

    const items = result.SearchResultItems;
    if (!Array.isArray(items)) return null;
    return items;
  }

  /** Map a JobBoardApi search-result item → normalised BeeSiteJob (null when unusable). */
  private normaliseApiItem(item: BeeSiteSearchResultItem, origin: string): BeeSiteJob | null {
    const descriptor = item?.MatchedObjectDescriptor;
    if (!descriptor || typeof descriptor !== 'object') return null;

    const atsId =
      this.numToText(descriptor.PositionID) ?? this.numToText(item.MatchedObjectId);
    if (!atsId) return null;

    const title = this.cleanText(descriptor.PositionTitle);
    const { city, state, country, locationText } = this.extractApiLocation(
      descriptor.PositionLocation,
    );
    const department = this.cleanText(descriptor.DepartmentName);
    const url = this.cleanText(descriptor.PositionURI) ?? this.buildDetailUrl(origin, atsId);

    return {
      atsId,
      url,
      applyUrl: this.buildApplyUrl(origin, atsId),
      title,
      companyName: this.cleanText(descriptor.OrganizationName),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.extractApiDescription(descriptor.PositionFormattedDescription),
      department,
      employmentType: this.extractApiEmploymentType(descriptor),
      datePosted: this.parseDate(descriptor.PublicationStartDate),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a parsed HTML search-list row → normalised BeeSiteJob (null when unusable). */
  private normaliseListRow(row: BeeSiteListRow, origin: string): BeeSiteJob | null {
    const atsId = this.cleanText(row.positionId);
    if (!atsId) return null;

    const title = this.cleanText(row.title);
    const locationText = this.cleanText(row.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      atsId,
      url: this.cleanText(row.url) ?? this.buildDetailUrl(origin, atsId),
      applyUrl: this.buildApplyUrl(origin, atsId),
      title,
      companyName: null, // the list row carries no brand name; derived later from the slug
      city,
      state,
      country,
      locationText,
      descriptionHtml: null, // the list row has no body; the detail page is not followed
      department: null,
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText, null),
    };
  }

  /** Map a normalised BeeSiteJob → JobPostDto. */
  private processJob(
    job: BeeSiteJob,
    tenantLabel: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenantLabel);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `beesite-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.BEESITE,
      atsId,
      atsType: 'beesite',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Parse the server-rendered search-list HTML into role rows. Scopes each role's
   * title / location to its surrounding `SearchResultBox` container when present;
   * otherwise reads the bare `?ac=jobad&id=` anchor (id + best-effort link text).
   */
  private parseSearchHtml(html: string, origin: string): BeeSiteListRow[] {
    const rows = this.parseResultBoxes(html, origin);
    if (rows.length > 0) return rows;
    // No SearchResultBox containers — fall back to anchoring on the job-ad links alone.
    return this.parseBareJobAdLinks(html, origin);
  }

  /** Parse each `SearchResultBox` container into a role row. */
  private parseResultBoxes(html: string, origin: string): BeeSiteListRow[] {
    const out: BeeSiteListRow[] = [];
    const seen = new Set<string>();
    BEESITE_RESULT_BOX_REGEX.lastIndex = 0;
    let boxMatch: RegExpExecArray | null;
    while ((boxMatch = BEESITE_RESULT_BOX_REGEX.exec(html)) !== null) {
      const block = boxMatch[1] ?? '';
      const link = this.firstJobAdLink(block, origin);
      if (!link) continue;
      if (seen.has(link.positionId)) continue;
      seen.add(link.positionId);

      // The first non-empty anchor text in the box is the most reliable title source;
      // fall back to the whole row text stripped to a single line.
      const title =
        this.firstAnchorText(block) ?? this.firstLine(this.stripTags(block));
      const location = this.extractRowLocation(block);

      out.push({ positionId: link.positionId, url: link.url, title, location });
    }
    return out;
  }

  /** Parse bare `?ac=jobad&id=` anchors when no SearchResultBox containers are present. */
  private parseBareJobAdLinks(html: string, origin: string): BeeSiteListRow[] {
    const out: BeeSiteListRow[] = [];
    const seen = new Set<string>();
    BEESITE_JOBAD_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BEESITE_JOBAD_LINK_REGEX.exec(html)) !== null) {
      const positionId = this.cleanText(match[1]);
      if (!positionId || seen.has(positionId)) continue;
      seen.add(positionId);
      // Pull the anchor's visible text as a best-effort title.
      const title = this.anchorTextAround(html, match.index);
      out.push({
        positionId,
        url: this.buildDetailUrl(origin, positionId),
        title,
        location: null,
      });
    }
    return out;
  }

  /** Find the first `?ac=jobad&id=` link inside a result-box block. */
  private firstJobAdLink(
    block: string,
    origin: string,
  ): { positionId: string; url: string } | null {
    BEESITE_JOBAD_LINK_REGEX.lastIndex = 0;
    const m = BEESITE_JOBAD_LINK_REGEX.exec(block);
    if (!m) return null;
    const positionId = this.cleanText(m[1]);
    if (!positionId) return null;
    return { positionId, url: this.buildDetailUrl(origin, positionId) };
  }

  /** First non-empty `<a>…</a>` text within a block, stripped + collapsed. */
  private firstAnchorText(block: string): string | null {
    const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const text = this.firstLine(this.stripTags(m[1] ?? ''));
      if (text) return text;
    }
    return null;
  }

  /** Best-effort anchor text immediately following a matched job-ad link index. */
  private anchorTextAround(html: string, index: number): string | null {
    // Read a small window from the matched link forward to the closing anchor tag.
    const window = html.slice(index, index + 600);
    const m = />([^<]{2,200})<\/a>/i.exec(window);
    return m ? this.firstLine(this.stripTags(m[1])) : null;
  }

  /**
   * Best-effort location text from a result-box block: a labelled location element
   * (class containing `Location`), else null. Kept defensive — a missing location is
   * normal and simply yields a null location on the role.
   */
  private extractRowLocation(block: string): string | null {
    const re =
      /<(?:span|div|td|li|p)\b[^>]*class="[^"]*\bLocation\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td|li|p)>/i;
    const m = re.exec(block);
    if (!m) return null;
    return this.firstLine(this.stripTags(m[1] ?? ''));
  }

  /** Flatten the JSON `PositionLocation` entries into structured + free-text parts. */
  private extractApiLocation(
    locations: BeeSitePositionLocation[] | null | undefined,
  ): { city: string | null; state: string | null; country: string | null; locationText: string | null } {
    if (!Array.isArray(locations) || locations.length === 0) {
      return { city: null, state: null, country: null, locationText: null };
    }
    const first = locations[0] ?? {};
    const city = this.cleanText(first.CityName) ?? this.cleanText(first.LocationName);
    const state = this.cleanText(first.CountrySubDivisionName);
    const country = this.cleanText(first.CountryName);
    const locationText =
      [city, state, country].filter((p): p is string => !!p).join(', ') || null;
    return { city, state, country, locationText };
  }

  /** Extract the HTML job-ad body from the `PositionFormattedDescription` field. */
  private extractApiDescription(
    value: BeeSiteFormattedContent | BeeSiteFormattedContent[] | null | undefined,
  ): string | null {
    if (!value) return null;
    const blocks = Array.isArray(value) ? value : [value];
    const parts = blocks
      .map((b) => this.cleanText(b?.Content))
      .filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Extract a readable employment-type label from the descriptor's schedule fields. */
  private extractApiEmploymentType(
    descriptor: BeeSiteMatchedObjectDescriptor,
  ): string | null {
    return (
      this.firstNamedLabel(descriptor.PositionOfferingType) ??
      this.firstNamedLabel(descriptor.PositionSchedule)
    );
  }

  /** Read the first `Name` out of a `{ Name }[]` / string field. */
  private firstNamedLabel(
    value: { Name?: string | null }[] | string | null | undefined,
  ): string | null {
    if (typeof value === 'string') return this.cleanText(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const name = this.cleanText(entry?.Name);
        if (name) return name;
      }
    }
    return null;
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
   * Resolve the BeeSite portal origin (scheme + host, no trailing slash). A
   * `companyUrl` (or a URL passed as the slug) is honoured verbatim — BeeSite portals
   * live on hosted `*.beesite.de` hosts AND on customer custom domains, so we keep the
   * caller's origin rather than forcing a sub-domain. A bare slug expands to the hosted
   * `{slug}.beesite.de` origin. Returns an empty string when neither yields an origin.
   */
  private resolveOrigin(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes('.')) {
        const fromUrl = this.originFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // A bare slug (no host) → the hosted careers origin.
      return this.originFromUrl(beesiteHostedOrigin(slug.toLowerCase()));
    }
    if (companyUrl) {
      const fromUrl = this.originFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Normalise any portal URL / host into a `scheme://host` origin (no trailing slash). */
  private originFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!host || host === 'www') return '';
      return `${u.protocol}//${u.host}`;
    } catch {
      // Malformed URL — no origin.
    }
    return '';
  }

  /**
   * Derive a display label for the tenant from the portal origin — the brand-ish host
   * label (the leading sub-domain for a hosted `*.beesite.de` host, else the host's
   * primary domain label), used to build a `companyName` when the data carries none.
   */
  private deriveTenantLabel(origin: string): string {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      const labels = host.split('.').filter((l) => l && l !== 'www');
      if (host.endsWith(BEESITE_ROOT_DOMAIN) && labels.length > 2) {
        // Hosted `{slug}.beesite.de` → the slug is the leading label.
        return labels[0];
      }
      // Custom domain → the primary domain label (e.g. `draeger` in `…draeger.com`).
      if (labels.length >= 2) return labels[labels.length - 2];
      return labels[0] ?? host;
    } catch {
      return origin;
    }
  }

  /** Build the canonical public `?ac=jobad&id={PositionID}` detail URL for a role. */
  private buildDetailUrl(origin: string, positionId: string): string {
    return `${origin}/${BEESITE_INDEX_PATH}?ac=${BEESITE_JOBAD_ACTION}&id=${encodeURIComponent(positionId)}`;
  }

  /** Build the canonical public `?ac=application&id={PositionID}` apply URL for a role. */
  private buildApplyUrl(origin: string, positionId: string): string {
    return `${origin}/${BEESITE_INDEX_PATH}?ac=${BEESITE_APPLY_ACTION}&id=${encodeURIComponent(positionId)}`;
  }

  /** De-slugify + title-case the tenant label into a display company name. */
  private deriveCompanyName(tenantLabel: string): string {
    const base = tenantLabel && tenantLabel.trim() ? tenantLabel.trim() : tenantLabel;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: BeeSiteJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * Comma-separated tail is treated as the country; the head as the city. A bare
   * "Remote" token yields a null location.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(',')
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    const country = parts[parts.length - 1];
    const city = parts.slice(0, parts.length - 1).join(', ');
    return { city: city || null, state: null, country: country || null };
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
      if (BEESITE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|home[\s-]?office|homeoffice)$/i.test(value.trim());
  }

  /**
   * Parse an ISO / date-ish timestamp value into a YYYY-MM-DD string. Non-absolute /
   * unparseable values yield null.
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

  /** Strip HTML tags from a fragment, decoding the handful of common entities. */
  private stripTags(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/gi, "'");
  }

  /** First non-empty line of a string, with collapsed inner whitespace. */
  private firstLine(value: string): string | null {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length > 0 ? collapsed : null;
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
