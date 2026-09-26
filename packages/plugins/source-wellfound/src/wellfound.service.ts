import { SourcePlugin } from '@ever-jobs/plugin';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import { BrowserPool, createHttpClient, HttpClient, randomSleep } from '@ever-jobs/common';
import {
  parseWellfoundOption,
  WELLFOUND_DEFAULT_DESCRIPTION_SOURCE,
  WELLFOUND_DEFAULT_FETCH_MODE,
  WELLFOUND_DEFAULT_JOB_URL_STYLE,
  WELLFOUND_DEFAULT_RESULTS,
  WELLFOUND_DEFAULT_ROUTE_MODE,
  WELLFOUND_DELAY_MAX,
  WELLFOUND_DELAY_MIN,
  WELLFOUND_DESCRIPTION_SOURCE_ENV,
  WELLFOUND_DESCRIPTION_SOURCES,
  WELLFOUND_FETCH_MODE_ENV,
  WELLFOUND_FETCH_MODES,
  WELLFOUND_HTTP_HEADERS,
  WELLFOUND_JOB_URL_STYLE_ENV,
  WELLFOUND_JOB_URL_STYLES,
  WELLFOUND_MAX_PAGES,
  WELLFOUND_ROUTE_MODE_ENV,
  WELLFOUND_ROUTE_MODES,
  WELLFOUND_USER_AGENT,
  WellfoundDescriptionSource,
  WellfoundFetchMode,
  WellfoundJobUrlStyle,
  WellfoundRouteMode,
} from './wellfound.constants';
import {
  collectListings,
  extractNextData,
  findSearchConnection,
  getApolloData,
  listingId,
  listingPostedMs,
  listingSearchText,
  looksLikeWellfoundChallenge,
  mapListing,
  matchesAllTerms,
  matchesPlace,
  parseNextDataJson,
  planRoutes,
  roleConfirmed,
  WellfoundMapOptions,
  WellfoundRouteAttempt,
} from './wellfound.parser';
import { ApolloCache, WellfoundListingPair, WellfoundNextData } from './wellfound.types';

type BrowserPage = Awaited<ReturnType<typeof BrowserPool.getPage>>;

/** The operator options in force for one scrape. */
export interface WellfoundRunOptions {
  fetchMode: WellfoundFetchMode;
  routeMode: WellfoundRouteMode;
  descriptionSource: WellfoundDescriptionSource;
  jobUrlStyle: WellfoundJobUrlStyle;
}

/** A page that carried a usable payload. */
type PageOk = { kind: 'ok'; status: number; nd: WellfoundNextData; data: ApolloCache };

/** What one page request produced. */
type PageFetch =
  | PageOk
  | { kind: 'not_found'; status: number; detail: string }
  | { kind: 'blocked'; status: number; detail: string }
  | { kind: 'drift'; status: number; detail: string }
  | { kind: 'no_payload'; status: number; detail: string }
  | { kind: 'error'; status: number; diagnostics: ScrapeDiagnostics };

/**
 * State of one scrape. The service is a singleton shared by concurrent
 * scrapes, so nothing per-run may live on `this`.
 */
interface ScrapeRun {
  input: ScraperInputDto;
  options: WellfoundRunOptions;
  timeoutMs: number;
  client: HttpClient | null;
  page: BrowserPage | null;
}

/** Filters that apply to every route, from the caller's input. */
interface InputFilters {
  cutoffMs: number | null;
  jobType: ScraperInputDto['jobType'] | null;
}

const NEXT_DATA_SCRIPT = `(() => { const s = document.getElementById('__NEXT_DATA__'); return s ? s.textContent : null; })()`;

@SourcePlugin({
  site: Site.WELLFOUND,
  name: 'Wellfound',
  category: 'niche',
  description:
    'Startup jobs from Wellfound role/location landing pages (SSR Apollo cache); per-company boards are source-ats-wellfound.',
  // Spec 1700 — the plugin keeps 3-7 s between requests; hold location calls to the same floor.
  minRequestIntervalMs: WELLFOUND_DELAY_MIN,
})
@Injectable()
export class WellfoundService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(WellfoundService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const run: ScrapeRun = {
      input,
      options: this.resolveOptions(),
      timeoutMs: (input.requestTimeout ?? 30) * 1000,
      client: null,
      page: null,
    };

    try {
      const plan = planRoutes(input, run.options.routeMode);
      let sawNoPayload = false;
      for (const attempt of plan) {
        const first = await this.fetchPage(run, attempt.url(1));
        if (first.kind === 'blocked') {
          this.logger.warn(`Wellfound: blocked on ${attempt.url(1)} (${first.detail})`);
          return new JobResponseDto([], new ScrapeDiagnostics('blocked', first.detail));
        }
        if (first.kind === 'error') return new JobResponseDto([], first.diagnostics);
        if (first.kind === 'drift') {
          this.logger.warn(`Wellfound: ${first.detail} on ${attempt.url(1)}`);
          return new JobResponseDto([], new ScrapeDiagnostics('unknown', first.detail));
        }
        if (first.kind === 'no_payload') {
          sawNoPayload = true;
          this.logger.debug(`Wellfound: ${first.detail} on ${attempt.url(1)}; trying the next route`);
          continue;
        }
        if (first.kind === 'not_found' || !this.isUsableFirstPage(first, attempt)) {
          this.logger.debug(`Wellfound: no ${attempt.kind} landing page at ${attempt.url(1)}; trying the next route`);
          continue;
        }
        return await this.collectRoute(run, attempt, first);
      }
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'empty',
          sawNoPayload ? 'no __NEXT_DATA__ payload on the landing pages' : 'no landing page for role/location',
        ),
      );
    } catch (err: unknown) {
      this.logger.error(`Wellfound scrape failed: ${err instanceof Error ? err.message : String(err)}`);
      return new JobResponseDto([], classifyScrapeError(err));
    } finally {
      await this.closeBrowserPage(run);
    }
  }

  /**
   * Page 1 of a route is trusted when it carries search results (a connection
   * or at least one listing) and, for a role route, names the requested role.
   * Anything else sends the scrape down the fallback chain.
   */
  private isUsableFirstPage(first: PageOk, attempt: WellfoundRouteAttempt): boolean {
    const hasResults = findSearchConnection(first.data, 1) !== null || collectListings(first.data, 1).length > 0;
    if (!hasResults) return false;
    return attempt.role === null || roleConfirmed(first.nd, first.data, attempt.role);
  }

  /**
   * Read a route page by page, sequentially, until enough listings match, the
   * declared page count or {@link WELLFOUND_MAX_PAGES} is reached, or a page
   * adds nothing new. A failure after page 1 keeps what was collected.
   */
  private async collectRoute(
    run: ScrapeRun,
    attempt: WellfoundRouteAttempt,
    first: PageOk,
  ): Promise<JobResponseDto> {
    const { input, options } = run;
    const resultsWanted = this.count(input.resultsWanted, WELLFOUND_DEFAULT_RESULTS, 1);
    const offset = this.count(input.offset, 0, 0);
    const want = offset + resultsWanted;
    const mapOptions: WellfoundMapOptions = {
      format: input.descriptionFormat,
      descriptionSource: options.descriptionSource,
      jobUrlStyle: options.jobUrlStyle,
    };
    const inputFilters: InputFilters = {
      cutoffMs: input.hoursOld && input.hoursOld > 0 ? Date.now() - input.hoursOld * 3_600_000 : null,
      jobType: input.jobType ?? null,
    };

    const declaredPages = findSearchConnection(first.data, 1)?.pageCount;
    const pageCountKnown = typeof declaredPages === 'number' && Number.isFinite(declaredPages) && declaredPages >= 1;
    const lastPage = Math.min(pageCountKnown ? Math.floor(declaredPages) : WELLFOUND_MAX_PAGES, WELLFOUND_MAX_PAGES);

    const seen = new Set<string>();
    const matched: JobPostDto[] = [];
    let fetched = 0;
    let failure: ScrapeDiagnostics | null = null;
    let data = first.data;
    let pageNum = 1;

    for (;;) {
      let added = 0;
      for (const pair of collectListings(data, pageNum)) {
        const id = listingId(pair.listing);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        added++;
        fetched++;
        const post = this.accept(pair, attempt, inputFilters, mapOptions);
        if (post) matched.push(post);
        if (matched.length >= want) break;
      }

      if (matched.length >= want || added === 0 || pageNum >= lastPage) break;

      pageNum++;
      await randomSleep(WELLFOUND_DELAY_MIN, WELLFOUND_DELAY_MAX);
      let next: PageFetch;
      try {
        next = await this.fetchPage(run, attempt.url(pageNum));
      } catch (err: unknown) {
        failure = classifyScrapeError(err);
        break;
      }
      if (next.kind === 'ok') {
        data = next.data;
        continue;
      }
      // Past the end of an open-ended feed is where pagination stops, not a failure.
      if (next.kind === 'not_found' && !pageCountKnown) break;
      failure =
        next.kind === 'error'
          ? next.diagnostics
          : new ScrapeDiagnostics(next.kind === 'blocked' ? 'blocked' : 'unknown', `page ${pageNum}: ${next.detail}`);
      break;
    }

    const jobs = matched.slice(offset, offset + resultsWanted);
    this.logger.log(
      `Wellfound: ${jobs.length} jobs from ${attempt.kind} route (${pageNum} page(s), ${fetched} listings read)`,
    );

    if (failure) {
      if (jobs.length === 0) return new JobResponseDto([], failure);
      return new JobResponseDto(
        jobs,
        new ScrapeDiagnostics('partial', `stopped at page ${pageNum}: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ''}`),
      );
    }
    if (jobs.length > 0) return new JobResponseDto(jobs);
    if (fetched === 0) return new JobResponseDto([], new ScrapeDiagnostics('empty', `no listings on the ${attempt.kind} route`));
    if (matched.length === 0) {
      return new JobResponseDto([], new ScrapeDiagnostics('empty', `${fetched} listings fetched, 0 matched filters`));
    }
    return new JobResponseDto(
      [],
      new ScrapeDiagnostics('empty', `offset ${offset} is past the ${matched.length} matching listings`),
    );
  }

  /** Apply the route's local filters and the caller's filters; map the survivors. */
  private accept(
    pair: WellfoundListingPair,
    attempt: WellfoundRouteAttempt,
    inputFilters: InputFilters,
    mapOptions: WellfoundMapOptions,
  ): JobPostDto | null {
    const { listing } = pair;
    const { filters } = attempt;
    if (filters.term && !matchesAllTerms(listingSearchText(pair), filters.term)) return null;
    if (filters.location && !matchesPlace(listing, filters.location)) return null;
    if (inputFilters.cutoffMs !== null) {
      const postedMs = listingPostedMs(listing);
      if (postedMs !== null && postedMs < inputFilters.cutoffMs) return null;
    }
    if (inputFilters.jobType && getJobTypeFromString(listing.jobType) !== inputFilters.jobType) return null;

    let post: JobPostDto | null;
    try {
      post = mapListing(pair, mapOptions);
    } catch (err: unknown) {
      this.logger.debug(
        `Wellfound: failed to map listing ${listingId(listing)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!post) return null;
    if (filters.remote && post.isRemote !== true) return null;
    return post;
  }

  private fetchPage(run: ScrapeRun, url: string): Promise<PageFetch> {
    return run.options.fetchMode === 'browser' ? this.fetchWithBrowser(run, url) : this.fetchWithHttp(run, url);
  }

  private async fetchWithHttp(run: ScrapeRun, url: string): Promise<PageFetch> {
    if (!run.client) {
      run.client = createHttpClient({
        ...run.input,
        userAgent: run.input.userAgent ?? WELLFOUND_USER_AGENT,
        allowedRedirectHosts: ['wellfound.com'],
      });
      run.client.setHeaders(WELLFOUND_HTTP_HEADERS);
    }
    this.logger.debug(`Wellfound: GET ${url}`);
    // 429 and 5xx still throw, so the client's retry/backoff applies; other
    // statuses come back to be classified.
    const res = await run.client.get<string>(url, {
      responseType: 'text',
      validateStatus: (status: number) => status < 500 && status !== 429,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    return this.classifyPage(res.status, extractNextData(html), html, 'http');
  }

  /** The pre-Spec-1708 transport, behind `WELLFOUND_FETCH_MODE=browser`. One page per scrape. */
  private async fetchWithBrowser(run: ScrapeRun, url: string): Promise<PageFetch> {
    if (!run.page) run.page = await BrowserPool.getPage({ proxy: run.input.proxies?.[0] ?? undefined });
    this.logger.debug(`Wellfound: navigating to ${url}`);
    // Through the crawl policy (Spec 1690): pacing, egress guard, robots.txt, abort.
    const response = await BrowserPool.navigate(run.page, url, { waitUntil: 'domcontentloaded', timeout: run.timeoutMs });
    const status = response?.status() ?? 200;
    // The payload is server-rendered: it is in the DOM as soon as the document is.
    const json = (await run.page.evaluate(NEXT_DATA_SCRIPT)) as string | null;
    const nd = parseNextDataJson(json);
    const html = nd ? '' : ((await run.page.content().catch(() => '')) as string);
    return this.classifyPage(status, nd, html, 'browser');
  }

  /**
   * The payload is checked before any challenge marker: a normal page carries
   * the CDN's passive detection beacon and must not read as blocked.
   */
  private classifyPage(
    status: number,
    nd: WellfoundNextData | null,
    html: string,
    via: 'http' | 'browser',
  ): PageFetch {
    if (status === 404 || status === 410) return { kind: 'not_found', status, detail: `http ${status}` };
    if (nd) {
      if (nd.page === '/_error') return { kind: 'not_found', status, detail: 'not-found page' };
      const data = getApolloData(nd);
      if (!data) return { kind: 'drift', status, detail: 'payload shape changed: no apolloState.data' };
      return { kind: 'ok', status, nd, data };
    }
    if (status === 401 || status === 403 || status === 407 || looksLikeWellfoundChallenge(html)) {
      return { kind: 'blocked', status, detail: `bot challenge (${via} ${status})` };
    }
    if (status >= 400) {
      return { kind: 'error', status, diagnostics: classifyScrapeError(new Error(`Request failed with status code ${status}`)) };
    }
    return { kind: 'no_payload', status, detail: 'no __NEXT_DATA__' };
  }

  private async closeBrowserPage(run: ScrapeRun): Promise<void> {
    const page = run.page;
    if (!page) return;
    run.page = null;
    const context = page.context();
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  /** The options for this scrape, read from the environment on every call. */
  private resolveOptions(): WellfoundRunOptions {
    return {
      fetchMode: this.option(WELLFOUND_FETCH_MODE_ENV, WELLFOUND_FETCH_MODES, WELLFOUND_DEFAULT_FETCH_MODE),
      routeMode: this.option(WELLFOUND_ROUTE_MODE_ENV, WELLFOUND_ROUTE_MODES, WELLFOUND_DEFAULT_ROUTE_MODE),
      descriptionSource: this.option(
        WELLFOUND_DESCRIPTION_SOURCE_ENV,
        WELLFOUND_DESCRIPTION_SOURCES,
        WELLFOUND_DEFAULT_DESCRIPTION_SOURCE,
      ),
      jobUrlStyle: this.option(WELLFOUND_JOB_URL_STYLE_ENV, WELLFOUND_JOB_URL_STYLES, WELLFOUND_DEFAULT_JOB_URL_STYLE),
    };
  }

  private option<T extends string>(env: string, allowed: readonly T[], fallback: T): T {
    const raw = process.env[env];
    const parsed = parseWellfoundOption(raw, allowed, fallback);
    if (parsed !== null) return parsed;
    this.logger.warn(`Ignoring unrecognised ${env}="${raw}" (expected ${allowed.join('|')}); using "${fallback}"`);
    return fallback;
  }

  /** A whole number at least `min`, or `fallback`. */
  private count(value: unknown, fallback: number, min: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close();
  }
}
