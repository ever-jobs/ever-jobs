import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  ScrapeDiagnostics,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  postedFromTimestamp,
  postedTimeFields,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  WTTJ_ROOT_DOMAIN,
  WTTJ_ALGOLIA_INDEX_LOCALES,
  WTTJ_BOARD_ATTRIBUTES,
  WTTJ_BOARD_FALLBACK_LOCALE,
  WTTJ_BOARD_LOCALE,
  WTTJ_BOARD_WINDOW,
  WTTJ_BROWSER_UA_CRAWL_POLICY,
  WTTJ_BROWSER_USER_AGENT,
  WTTJ_CREDENTIAL_FETCH_INTERVAL_SECONDS,
  WTTJ_CREDENTIAL_HOSTS,
  WTTJ_CREDENTIAL_MAX_HTML_BYTES,
  WTTJ_ENV,
  WTTJ_PAGE_SIZE,
  WTTJ_MAX_PAGES,
  WTTJ_DEFAULT_RESULTS,
  WTTJ_DEFAULT_TIMEOUT_SECONDS,
  WTTJ_HEADERS,
  WTTJ_HONEST_USER_AGENT,
  WTTJ_RATE_DELAY_MAX_SECONDS,
  WTTJ_RATE_DELAY_MIN_SECONDS,
  wttjAlgoliaIndexName,
  wttjAlgoliaQueryUrl,
  wttjCompanyJobsUrl,
  wttjEnvOff,
  wttjEnvOn,
  wttjEnvValue,
} from './wttj.constants';
import {
  currentWttjCredentials,
  isWttjCredentialRejection,
  refreshWttjCredentials,
  rememberWttjDetailUrl,
  sameWttjCredentials,
  WttjCredentials,
  wttjCredentialHeaders,
  WttjHtmlFetcher,
} from './wttj.credentials';
import {
  assembleDescriptionHtml,
  companyIndustry,
  companyLogoUrl,
  companyNumEmployees,
  countryCodeFromOffices,
  experienceRangeFrom,
  jobTypesFromContract,
  legacyAssembleDescription,
  legacyRemoteFromToken,
  locationKey,
  officeLocations,
  remoteFromToken,
  structuredCompensation,
  urlLocale,
} from './wttj.mapper';
import {
  buildBoardQuery,
  hasBoardCriteria,
  planBoardWindow,
  WttjBoardQuery,
  WttjBoardWindow,
} from './wttj.query';
import {
  WttjAlgoliaResponse,
  WttjJob,
  WttjJobHit,
  WttjOffice,
} from './wttj.types';

type WttjHttpClient = ReturnType<typeof createHttpClient>;

/** One Algolia query's outcome, before the caller decides what it means. */
type WttjQueryOutcome =
  /** A 2xx answer (a non-object body is normalised to no hits). */
  | { kind: 'ok'; data: WttjAlgoliaResponse }
  /** An HTTP error status that is not a credential refusal. */
  | { kind: 'http'; status: number; error: unknown }
  /** No HTTP response at all (DNS, refused, reset, timeout). */
  | { kind: 'transport'; error: unknown }
  /** The key or referer was refused, and a refreshed key did not help. */
  | { kind: 'rejected' };

/** Per-scrape request state: the query client and a lazily built credential-page fetcher. */
interface WttjRequestContext {
  client: WttjHttpClient;
  fetchCredentialPage: WttjHtmlFetcher;
}

/** Hits collected for a scrape, and why the walk stopped early (when it did). */
interface WttjHitBatch {
  hits: WttjJobHit[];
  diagnostics?: ScrapeDiagnostics;
}

/** Which of the two scrape modes produced a hit. */
type WttjMode = 'company' | 'board';

const CREDENTIALS_BLOCKED_DETAIL =
  'Welcome to the Jungle search credentials were rejected and could not be rediscovered';
const WINDOW_CAPPED_DETAIL = 'Welcome to the Jungle search window is capped at 1000 hits per query';
const OFFSET_BEYOND_WINDOW_DETAIL = 'offset beyond the 1000-hit search window';

/**
 * Welcome to the Jungle (WTTJ) ATS careers scraper — generic, multi-tenant.
 *
 * Welcome to the Jungle (welcometothejungle.com, France / EU) is a recruitment and
 * employer-branding marketplace. Each company ("organization") publishes a branded,
 * public, unauthenticated jobs page on the shared host
 * `https://www.welcometothejungle.com/{lang}/companies/{slug}/jobs`. The candidate-facing
 * front-end is powered by a **public, anonymous Algolia search index** whose search-only
 * credentials are embedded in the WTTJ front-end JavaScript. Rather than scraping the
 * server-rendered HTML or driving a headless browser, the adapter queries that index
 * directly:
 *
 *   POST https://{appId}-dsn.algolia.net/1/indexes/{index}/query
 *     headers: x-algolia-application-id, x-algolia-api-key, Referer (allow-listed)
 *     body:    { query: '', hitsPerPage, page, facetFilters: [["organization.slug:{slug}"]] }
 *
 * and maps each returned hit. Each hit's `reference` (a stable per-role guid, equal to
 * `objectID`) is the ATS id, and its `slug` + the embedded `organization.slug` build the
 * canonical detail URL `/{lang}/companies/{org.slug}/jobs/{job.slug}` and apply URL
 * (the same path with `/apply` appended).
 *
 * Two modes (Spec 1705):
 *
 * - **Company mode** — the caller addresses a company by `companySlug` (e.g.
 *   `groupe-partnaire`) or by `companyUrl` (a WTTJ company-jobs URL whose
 *   `/companies/{slug}` segment encodes the slug). The body above is sent unchanged, `_en`
 *   then `_fr`. An unknown company, one with no open roles, or an empty index response
 *   degrades naturally to an empty result.
 * - **Board mode** — {@link scrapeBoard}, and `scrape()` when no company is given but a
 *   search criterion is (`searchTerm`, `location`, `hoursOld`, `isRemote: true`,
 *   `jobType`). It searches the whole index (`_en` only, as `_fr` holds the same postings),
 *   paced and capped at the index's 1,000-hit window. `scrape()` does this only with
 *   `WTTJ_BOARD_MODE=on` (opt-in until the owner rules on Q-099); by default it stays
 *   company-only, as before Spec 1705.
 *
 * Both modes share the hit mapping (strict remote tokens, key missions, structured salary,
 * job types, every office, company metadata) and the credential self-heal: when the index
 * refuses the public key, it is re-read once from a public detail page and the query is
 * retried once; a key that stays refused is reported as `blocked` instead of an empty
 * board. Nothing here throws: failures degrade to partial results with a diagnostic, so a
 * single company never nukes a batch run.
 */
@SourcePlugin({
  site: Site.WTTJ,
  name: 'Welcome to the Jungle',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WelcomeToTheJungleService implements IScraper {
  private readonly logger = new Logger(WelcomeToTheJungleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      if (wttjEnvOn(WTTJ_ENV.BOARD_MODE) && hasBoardCriteria(input)) {
        return this.scrapeBoard(input);
      }
      this.logger.warn('No companySlug or companyUrl provided for WelcomeToTheJungle scraper');
      // Say why the result is empty: without a company only the board search could
      // answer, and it is opt-in (Q-099) — an empty list alone reads as "no jobs".
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'bad_input',
          hasBoardCriteria(input)
            ? `no companySlug or companyUrl; board-wide search is off (set ${WTTJ_ENV.BOARD_MODE}=on to enable it)`
            : 'no companySlug or companyUrl',
        ),
      );
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a WelcomeToTheJungle company slug from input');
      return new JobResponseDto([]);
    }

    const ctx = this.createRequestContext(input);
    const resultsWanted = input.resultsWanted ?? WTTJ_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching WelcomeToTheJungle jobs for company: ${slug}`);

      const batch = await this.fetchHits(ctx, slug, resultsWanted);
      if (batch.hits.length === 0) {
        if (!batch.diagnostics) {
          this.logger.log(`WelcomeToTheJungle company "${slug}" has no reachable open roles`);
        }
        return new JobResponseDto([], batch.diagnostics);
      }

      const seen = new Set<string>();
      for (const hit of batch.hits) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processHit(hit, slug, input.descriptionFormat, seen, 'company');
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing WelcomeToTheJungle role ${hit?.reference ?? hit?.objectID}: ${err.message}`,
          );
        }
      }

      this.logger.log(`WelcomeToTheJungle total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts, batch.diagnostics);
    } catch (err: any) {
      this.logger.error(`WelcomeToTheJungle scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Board-wide search over the whole index (Spec 1705 work item A). Always runs board
   * mode: `companySlug` / `companyUrl` are ignored, and an input with no criteria returns
   * the newest postings.
   *
   * Reads one index (`_en`; `_fr` only if `_en` is missing), one page at a time, paced by
   * the shared HttpClient, and never past the index's 1,000-hit window:
   * `offset >= 1000` returns `bad_input` without a request, and a request the window cuts
   * short returns what is reachable with a `partial` diagnostic. Never throws.
   */
  async scrapeBoard(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobPosts: JobPostDto[] = [];
    try {
      const window = planBoardWindow(input);
      if (!window) {
        this.logger.warn(`WelcomeToTheJungle board search: offset ${input.offset} is past the window`);
        return new JobResponseDto([], new ScrapeDiagnostics('bad_input', OFFSET_BEYOND_WINDOW_DETAIL));
      }

      const query = buildBoardQuery(input, Math.floor(Date.now() / 1000));
      if (query.ignored.length > 0) {
        this.logger.debug(`WelcomeToTheJungle board search ignores: ${query.ignored.join(', ')}`);
      }
      this.logger.log(
        `Searching the WelcomeToTheJungle board: query "${query.query}", ` +
          `${query.facetFilters.length} facet group(s), ${query.numericFilters.length} numeric filter(s)`,
      );

      const ctx = this.createRequestContext(input);
      const batch = await this.fetchBoardHits(ctx, query, window);

      const seen = new Set<string>();
      for (const hit of batch.hits) {
        if (jobPosts.length >= window.want) break;
        try {
          const post = this.processHit(hit, '', input.descriptionFormat, seen, 'board');
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing WelcomeToTheJungle role ${hit?.reference ?? hit?.objectID}: ${err.message}`,
          );
        }
      }

      // The window notice only means something next to jobs; alone it is just an empty page.
      const diagnostics =
        batch.diagnostics?.reason === 'partial' && jobPosts.length === 0 ? undefined : batch.diagnostics;
      this.logger.log(`WelcomeToTheJungle board search total: ${jobPosts.length} jobs`);
      return new JobResponseDto(jobPosts, diagnostics);
    } catch (err: any) {
      this.logger.error(`WelcomeToTheJungle board search error: ${err.message}`);
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * The query client (paced, capped timeout, identifying user agent) and a credential-page
   * fetcher that is only built if the index ever refuses the key.
   */
  private createRequestContext(input: ScraperInputDto): WttjRequestContext {
    // Cap the per-request timeout so an unresponsive Algolia DSN degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? WTTJ_DEFAULT_TIMEOUT_SECONDS,
      WTTJ_DEFAULT_TIMEOUT_SECONDS,
    );
    const userAgent = this.resolveUserAgent(input.userAgent);
    // WTTJ_USER_AGENT_MODE=browser: the plugin UA is only declared (Spec 1690 §4.2), so
    // the switch also opts the clients into userAgentMode 'plugin'; strict still wins.
    const uaOptIn = this.browserUserAgentSwitchOn() ? { crawl: WTTJ_BROWSER_UA_CRAWL_POLICY } : {};
    // Pace every request after the first; a caller's slower pacing wins.
    const rateDelayMin = Math.max(input.rateDelayMin ?? 0, WTTJ_RATE_DELAY_MIN_SECONDS);
    const rateDelayMax = Math.max(input.rateDelayMax ?? 0, WTTJ_RATE_DELAY_MAX_SECONDS, rateDelayMin);
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
      userAgent,
      rateDelayMin,
      rateDelayMax,
      // Since Spec 1690 rateDelayMin is only the plugin layer, which a caller override
      // replaces; the floor keeps a caller from shortening the pacing.
      minIntervalFloorMs: rateDelayMin * 1000,
      ...uaOptIn,
    });
    client.setHeaders({ ...WTTJ_HEADERS, 'User-Agent': userAgent });

    let pageClient: WttjHttpClient | null = null;
    const fetchCredentialPage: WttjHtmlFetcher = async (url) => {
      if (!pageClient) {
        pageClient = createHttpClient({
          proxies: input.proxies,
          caCert: input.caCert,
          timeout: timeoutSeconds,
          requestTimeout: timeoutSeconds,
          userAgent,
          retries: 0,
          rateDelayMin: WTTJ_CREDENTIAL_FETCH_INTERVAL_SECONDS,
          rateDelayMax: WTTJ_CREDENTIAL_FETCH_INTERVAL_SECONDS,
          minIntervalFloorMs: WTTJ_CREDENTIAL_FETCH_INTERVAL_SECONDS * 1000,
          allowedRedirectHosts: WTTJ_CREDENTIAL_HOSTS,
          ...uaOptIn,
        });
        pageClient.setHeaders({
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': userAgent,
        });
      }
      const response = await pageClient.get<string>(url, {
        responseType: 'text',
        maxContentLength: WTTJ_CREDENTIAL_MAX_HTML_BYTES,
      });
      return typeof response?.data === 'string' ? response.data : null;
    };

    return { client, fetchCredentialPage };
  }

  /**
   * The request user agent: the caller's `userAgent` when given, else the identifying
   * one, or the pre-Spec-1705 browser string when `WTTJ_USER_AGENT_MODE=browser`.
   */
  private resolveUserAgent(requested: string | undefined): string {
    const own = typeof requested === 'string' ? requested.trim() : '';
    if (own) return own;
    return this.browserUserAgentSwitchOn() ? WTTJ_BROWSER_USER_AGENT : WTTJ_HONEST_USER_AGENT;
  }

  /** `WTTJ_USER_AGENT_MODE=browser` is set (Spec 1705 D-05). */
  private browserUserAgentSwitchOn(): boolean {
    return wttjEnvValue(WTTJ_ENV.USER_AGENT_MODE) === 'browser';
  }

  /**
   * Query the public Algolia job index for the company, walking pages until
   * `resultsWanted` is satisfied or the pages are exhausted. The localised indexes are
   * tried in order; the first index that yields any hits for the company wins. An unknown
   * company or a disabled / missing index (HTTP 4xx) degrades to an empty list; a network
   * failure or a refused key stops the walk and returns what was collected, with a
   * diagnostic (never throws).
   */
  private async fetchHits(
    ctx: WttjRequestContext,
    slug: string,
    resultsWanted: number,
  ): Promise<WttjHitBatch> {
    for (const locale of WTTJ_ALGOLIA_INDEX_LOCALES) {
      const items: WttjJobHit[] = [];
      const seen = new Set<string>();
      // Bound the page walk: by resultsWanted, by the configured page cap, and (once the
      // first page reports nbPages) by the company's actual page count.
      let totalPages = WTTJ_MAX_PAGES;

      for (let page = 0; page < Math.min(totalPages, WTTJ_MAX_PAGES); page++) {
        const outcome = await this.queryIndex(ctx, locale, this.companyQueryBody(slug, page), slug);
        // A transport-level failure (DNS / refused / reset / timeout) means the Algolia
        // DSN itself is unreachable — no other page/index can succeed, so abort.
        if (outcome.kind === 'transport') {
          return { hits: items, diagnostics: classifyScrapeError(outcome.error) };
        }
        // A refused key is the same for every index: stop, and say so.
        if (outcome.kind === 'rejected') {
          return { hits: items, diagnostics: new ScrapeDiagnostics('blocked', CREDENTIALS_BLOCKED_DETAIL) };
        }
        // Any other HTTP status is "no roles on this index" (unchanged behaviour).
        const response: WttjAlgoliaResponse = outcome.kind === 'ok' ? outcome.data : { hits: [] };

        if (typeof response.nbPages === 'number' && response.nbPages > 0) {
          totalPages = response.nbPages;
        }

        const hits = Array.isArray(response.hits) ? response.hits : [];
        let added = 0;
        for (const hit of hits) {
          const key = this.deriveAtsId(hit);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push(hit);
          added++;
          if (items.length >= resultsWanted) return { hits: items };
        }

        // Stop the page walk once a page yields no new hits (empty / exhausted board).
        if (added === 0) break;
      }

      if (items.length > 0) {
        this.logger.log(
          `WelcomeToTheJungle index ${this.indexNameFor(locale)} yielded ${items.length} jobs for ${slug}`,
        );
        return { hits: items };
      }
    }

    return { hits: [] };
  }

  /** The company-mode request body (unchanged since the plugin was added). */
  private companyQueryBody(slug: string, page: number): Record<string, unknown> {
    return {
      query: '',
      hitsPerPage: WTTJ_PAGE_SIZE,
      page,
      // Restrict to the company's roles; the embedded organization slug is the facet key.
      facetFilters: [[`organization.slug:${slug}`]],
    };
  }

  /**
   * Walk board pages (Spec 1705 A3): one page at a time from `window.firstPage`, skipping
   * `window.skip` hits on the first, until `window.want` hits are collected, a page is
   * empty, the index reports no more pages, the 1,000-hit window ends, or
   * {@link WTTJ_MAX_PAGES} pages were read.
   */
  private async fetchBoardHits(
    ctx: WttjRequestContext,
    query: WttjBoardQuery,
    window: WttjBoardWindow,
  ): Promise<WttjHitBatch> {
    const items: WttjJobHit[] = [];
    const seen = new Set<string>();
    let locale = WTTJ_BOARD_LOCALE;
    let triedFallback = false;
    let page = window.firstPage;
    let skip = window.skip;
    let nbHits: number | null = null;

    for (let requests = 0; requests < WTTJ_MAX_PAGES && items.length < window.want; requests++) {
      // A page that starts at or beyond the window returns nothing: do not ask.
      if (page * window.hitsPerPage >= WTTJ_BOARD_WINDOW) break;

      const outcome = await this.queryIndex(ctx, locale, this.boardQueryBody(query, page, window.hitsPerPage), 'board search');
      if (outcome.kind === 'transport') {
        return { hits: items, diagnostics: classifyScrapeError(outcome.error) };
      }
      if (outcome.kind === 'rejected') {
        return { hits: items, diagnostics: new ScrapeDiagnostics('blocked', CREDENTIALS_BLOCKED_DETAIL) };
      }
      if (outcome.kind === 'http') {
        // A missing board index (404 / 400) falls back to the other locale once.
        const missingIndex = outcome.status === 404 || outcome.status === 400;
        if (missingIndex && !triedFallback && items.length === 0 && page === window.firstPage) {
          this.logger.warn(
            `WelcomeToTheJungle index ${this.indexNameFor(locale)} answered HTTP ${outcome.status}; trying ${this.indexNameFor(WTTJ_BOARD_FALLBACK_LOCALE)}`,
          );
          locale = WTTJ_BOARD_FALLBACK_LOCALE;
          triedFallback = true;
          continue;
        }
        return { hits: items, diagnostics: classifyScrapeError(outcome.error) };
      }

      const data = outcome.data;
      if (typeof data.nbHits === 'number' && Number.isFinite(data.nbHits)) nbHits = data.nbHits;
      const hits = Array.isArray(data.hits) ? data.hits : [];
      if (hits.length === 0) break;

      for (let i = skip; i < hits.length && items.length < window.want; i++) {
        const hit = hits[i];
        const key = hit ? this.deriveAtsId(hit) : null;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(hit);
      }
      skip = 0;

      if (typeof data.nbPages === 'number' && data.nbPages > 0 && page + 1 >= data.nbPages) break;
      page++;
    }

    // The window, not the board, ended the walk: more matches exist than we may read.
    const capped =
      window.truncated &&
      items.length > 0 &&
      items.length >= window.want &&
      (nbHits === null || nbHits > window.offset + items.length);
    return capped
      ? { hits: items, diagnostics: new ScrapeDiagnostics('partial', WINDOW_CAPPED_DETAIL) }
      : { hits: items };
  }

  /** The board-mode request body: filters, one fixed page size, and a small payload. */
  private boardQueryBody(query: WttjBoardQuery, page: number, hitsPerPage: number): Record<string, unknown> {
    return {
      query: query.query,
      hitsPerPage,
      page,
      ...(query.facetFilters.length > 0 ? { facetFilters: query.facetFilters } : {}),
      ...(query.numericFilters.length > 0 ? { numericFilters: query.numericFilters } : {}),
      attributesToHighlight: [],
      attributesToSnippet: [],
      attributesToRetrieve: [...WTTJ_BOARD_ATTRIBUTES],
    };
  }

  /** The index name for a locale under the current credentials' prefix. */
  private indexNameFor(locale: string): string {
    return wttjAlgoliaIndexName(currentWttjCredentials().indexPrefix, locale);
  }

  /**
   * POST one Algolia query page, with the credential self-heal (Spec 1705 work item C):
   * when the index refuses the key, the credentials are re-read once (single-flight,
   * rate-limited) and the query is retried exactly once. A refresh that is disabled, finds
   * nothing, or finds the same key gives `rejected`. Never throws.
   */
  private async queryIndex(
    ctx: WttjRequestContext,
    locale: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<WttjQueryOutcome> {
    const creds = currentWttjCredentials();
    const first = await this.sendQuery(ctx.client, creds, locale, body, label);
    if (first.kind !== 'rejected') return first;

    if (wttjEnvOff(WTTJ_ENV.CREDENTIAL_REFRESH)) {
      this.logger.warn(`WelcomeToTheJungle search key refused for ${label}; credential refresh is off`);
      return first;
    }
    this.logger.warn(`WelcomeToTheJungle search key refused for ${label}; re-reading the public credentials`);
    const fresh = await refreshWttjCredentials(creds, ctx.fetchCredentialPage);
    if (!fresh || sameWttjCredentials(fresh, creds)) return first;
    return this.sendQuery(ctx.client, fresh, locale, body, label);
  }

  /** One POST with a given credential set, classified. Never throws. */
  private async sendQuery(
    client: WttjHttpClient,
    creds: WttjCredentials,
    locale: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<WttjQueryOutcome> {
    const index = wttjAlgoliaIndexName(creds.indexPrefix, locale);
    const url = wttjAlgoliaQueryUrl(index, creds.appId);
    try {
      const response = await client.post<WttjAlgoliaResponse>(url, body, {
        headers: wttjCredentialHeaders(creds),
      });
      const data = response?.data;
      if (data && typeof data === 'object') {
        const hasHits = Array.isArray(data.hits) && data.hits.length > 0;
        if (!hasHits && isWttjCredentialRejection(undefined, data.message)) return { kind: 'rejected' };
        return { kind: 'ok', data: data as WttjAlgoliaResponse };
      }
      // A 200 with a non-object / empty body is treated as "no roles" (reachable host).
      return { kind: 'ok', data: { hits: [] } };
    } catch (err: any) {
      const status = err?.response?.status;
      if (typeof status === 'number') {
        if (isWttjCredentialRejection(status, err?.response?.data?.message)) return { kind: 'rejected' };
        // The host answered an HTTP status (4xx / 5xx) — it is reachable.
        this.logger.warn(`WelcomeToTheJungle index ${index} returned HTTP ${status} for ${label}`);
        return { kind: 'http', status, error: err };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
      this.logger.warn(`WelcomeToTheJungle query failed for ${label}: ${err?.message ?? err}`);
      return { kind: 'transport', error: err };
    }
  }

  /** Map a parsed Algolia hit → JobPostDto, deduping by ATS id. */
  private processHit(
    hit: WttjJobHit,
    slug: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    mode: WttjMode,
  ): JobPostDto | null {
    const job = this.normaliseHit(hit, slug);
    if (!job) {
      if (mode === 'board') this.logger.debug('Skipping a WelcomeToTheJungle hit with no id or company slug');
      return null;
    }
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, slug, format);
  }

  /** Build a normalised WttjJob from a parsed Algolia hit. */
  private normaliseHit(hit: WttjJobHit, slug: string): WttjJob | null {
    const atsId = this.deriveAtsId(hit);
    if (!atsId) return null;

    // Prefer the embedded organization slug for URL building; fall back to the requested
    // slug so a canonical URL is always producible. Board mode has no requested slug, so
    // a hit without one cannot be linked and is skipped.
    const orgSlug = this.cleanText(hit.organization?.slug) ?? slug;
    if (!orgSlug) return null;
    const lang = urlLocale(hit.language, !wttjEnvOff(WTTJ_ENV.URL_LOCALE_GUARD));
    const jobSlug = this.cleanText(hit.slug);

    const url = this.buildDetailUrl(lang, orgSlug, jobSlug);
    const applyUrl = this.buildApplyUrl(lang, orgSlug, jobSlug);

    const office = this.pickOffice(hit.offices);
    const department = this.deriveDepartment(hit);
    const descriptionHtml = this.assembleDescription(hit);
    const remote = remoteFromToken(hit.remote, this.remoteHaystack(hit, office));
    const isRemote =
      wttjEnvValue(WTTJ_ENV.REMOTE_MODE) === 'legacy'
        ? legacyRemoteFromToken(hit.remote, this.remoteHaystack(hit, office))
        : remote.isRemote;

    const compensation = resolveCompensation({
      structured: structuredCompensation(hit),
      text: descriptionHtml ? htmlToPlainText(descriptionHtml) : null,
    });

    const datePosted = this.parseDate(hit.published_at) ?? this.parseDate(hit.published_at_date);
    const posted = this.postedDetail(hit, datePosted);

    return {
      atsId,
      url,
      applyUrl,
      title: this.cleanText(hit.name),
      companyName: this.cleanText(hit.organization?.name) ?? this.deriveCompanyName(orgSlug),
      city: this.cleanText(office?.city),
      state: this.cleanText(office?.state),
      country: this.cleanText(office?.country),
      descriptionHtml,
      department,
      employmentType: this.normaliseContractType(hit.contract_type),
      datePosted,
      ...posted,
      isRemote,
      workFromHomeType: remote.workFromHomeType,
      jobType: jobTypesFromContract(hit.contract_type, hit.language),
      compensation,
      countryCode: countryCodeFromOffices(hit.offices, office),
      locations: officeLocations(hit.offices),
      companyLogo: companyLogoUrl(hit.organization),
      companyIndustry: companyIndustry(hit.sectors),
      companyNumEmployees: companyNumEmployees(hit.organization),
      companyDescription: this.cleanText(hit.organization?.summary),
      jobFunction: this.cleanText(hit.new_profession?.category_name),
      experienceRange: experienceRangeFrom(hit),
    };
  }

  /**
   * The posting instant and its precision (Spec 1696), from `published_at` (else the epoch
   * `published_at_timestamp`). Only kept when its day agrees with `datePosted`, so the
   * date the plugin has always emitted never changes.
   */
  private postedDetail(
    hit: WttjJobHit,
    datePosted: string | null,
  ): Pick<WttjJob, 'datePostedAt' | 'datePostedPrecision' | 'datePostedBasis'> {
    if (!datePosted) return {};
    const source = this.cleanText(hit.published_at) ?? hit.published_at_timestamp ?? null;
    if (source === null) return {};
    const fields = postedTimeFields(postedFromTimestamp(source));
    if (fields.datePosted !== datePosted) return {};
    return {
      ...(fields.datePostedAt ? { datePostedAt: fields.datePostedAt } : {}),
      ...(fields.datePostedPrecision ? { datePostedPrecision: fields.datePostedPrecision } : {}),
      ...(fields.datePostedBasis ? { datePostedBasis: fields.datePostedBasis } : {}),
    };
  }

  /** Map a normalised WttjJob → JobPostDto. */
  private processJob(
    job: WttjJob,
    slug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    const location = this.extractLocation(job);
    const locations = this.allLocations(location, job.locations ?? []);
    rememberWttjDetailUrl(jobUrl);
    return new JobPostDto({
      id: `wttj-${atsId}`,
      title,
      companyName,
      jobUrl,
      location,
      ...(locations.length > 0 ? { locations } : {}),
      ...(job.countryCode ? { countryCode: job.countryCode } : {}),
      description,
      datePosted: job.datePosted ?? null,
      ...(job.datePostedAt ? { datePostedAt: job.datePostedAt } : {}),
      ...(job.datePostedPrecision ? { datePostedPrecision: job.datePostedPrecision } : {}),
      ...(job.datePostedBasis ? { datePostedBasis: job.datePostedBasis } : {}),
      isRemote: job.isRemote ?? false,
      ...(job.workFromHomeType ? { workFromHomeType: job.workFromHomeType } : {}),
      ...(job.jobType && job.jobType.length > 0 ? { jobType: job.jobType } : {}),
      ...(job.compensation ? { compensation: job.compensation } : {}),
      emails: extractEmails(description ?? ''),
      site: Site.WTTJ,
      atsId,
      atsType: 'wttj',
      department: job.department ?? null,
      ...(job.jobFunction ? { jobFunction: job.jobFunction } : {}),
      employmentType: job.employmentType ?? null,
      ...(job.experienceRange ? { experienceRange: job.experienceRange } : {}),
      ...(job.companyLogo ? { companyLogo: job.companyLogo } : {}),
      ...(job.companyIndustry ? { companyIndustry: job.companyIndustry } : {}),
      ...(job.companyNumEmployees ? { companyNumEmployees: job.companyNumEmployees } : {}),
      ...(job.companyDescription ? { companyDescription: job.companyDescription } : {}),
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Every office as a location, the primary one (`location`) first and without a
   * duplicate of it.
   */
  private allLocations(primary: LocationDto | null, offices: LocationDto[]): LocationDto[] {
    if (!primary) return offices;
    const primaryKey = locationKey(primary);
    return [primary, ...offices.filter((loc) => locationKey(loc) !== primaryKey)];
  }

  /**
   * Derive the stable ATS id from a hit: prefer the `reference` guid, then the
   * equivalent `objectID`. Returns null when neither is usable.
   */
  private deriveAtsId(hit: WttjJobHit): string | null {
    return this.cleanText(hit.reference) ?? this.cleanText(hit.objectID);
  }

  /**
   * Assemble the job-ad body from the hit's section fragments: the summary, the key
   * missions as a list, then the profile (Spec 1705 B2). `WTTJ_DESCRIPTION_LAYOUT=legacy`
   * keeps the pre-Spec-1705 body (a string missions value + profile, else the summary).
   */
  private assembleDescription(hit: WttjJobHit): string | null {
    if (wttjEnvValue(WTTJ_ENV.DESCRIPTION_LAYOUT) === 'legacy') return legacyAssembleDescription(hit);
    return assembleDescriptionHtml(hit);
  }

  /** Pick the first usable office from a hit's offices array. */
  private pickOffice(offices: WttjOffice[] | null | undefined): WttjOffice | null {
    if (!Array.isArray(offices) || offices.length === 0) return null;
    const withCity = offices.find((o) => this.cleanText(o?.city));
    return withCity ?? offices[0] ?? null;
  }

  /**
   * Derive a department / profession label from the hit's profession classification,
   * preferring the sub-category, then the category, then the pivot label.
   */
  private deriveDepartment(hit: WttjJobHit): string | null {
    const prof = hit.new_profession;
    if (!prof) return null;
    return (
      this.cleanText(prof.sub_category_name) ??
      this.cleanText(prof.category_name) ??
      this.cleanText(prof.pivot_name)
    );
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The body fragments are HTML-ish, so
   * HTML returns them as-is, Markdown converts them, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the company slug. An explicit `companySlug` is used directly (a bare
   * company-jobs URL passed as the slug is reduced to its `/companies/{slug}` token); a
   * `companyUrl` on a `welcometothejungle.com` host has the slug taken from its
   * `/companies/{slug}` path segment. Returns an empty string when neither yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full company-jobs URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(WTTJ_ROOT_DOMAIN)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the company slug from a WTTJ URL. Company pages live at
   * `welcometothejungle.com/{lang}/companies/{slug}/…`; the slug is the path segment
   * immediately after `companies`.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(WTTJ_ROOT_DOMAIN)) {
        // Not a WTTJ host — no derivable slug.
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const idx = segments.findIndex((s) => s.toLowerCase() === 'companies');
      if (idx >= 0 && segments[idx + 1]) {
        return decodeURIComponent(segments[idx + 1]).toLowerCase();
      }
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** Build the canonical public detail URL for a role. */
  private buildDetailUrl(lang: string, orgSlug: string, jobSlug: string | null): string {
    const base = wttjCompanyJobsUrl(lang, orgSlug);
    return jobSlug ? `${base}/${encodeURIComponent(jobSlug)}` : base;
  }

  /** Build the canonical public apply URL for a role (detail URL + `/apply`). */
  private buildApplyUrl(lang: string, orgSlug: string, jobSlug: string | null): string {
    const detail = this.buildDetailUrl(lang, orgSlug, jobSlug);
    return jobSlug ? `${detail}/apply` : detail;
  }

  /** De-slugify + title-case the company slug into a display name (fallback only). */
  private deriveCompanyName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: WttjJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** The free text the remote fallback reads: title, primary office, profession. */
  private remoteHaystack(hit: WttjJobHit, office: WttjOffice | null): Array<string | null> {
    return [
      this.cleanText(hit.name),
      this.cleanText(office?.city),
      this.cleanText(office?.state),
      this.deriveDepartment(hit),
    ];
  }

  /**
   * Normalise a WTTJ `contract_type` token (e.g. `full_time`, `part_time`,
   * `internship`, `apprenticeship`, `vie`) into a readable, trimmed, title-cased label.
   */
  private normaliseContractType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
