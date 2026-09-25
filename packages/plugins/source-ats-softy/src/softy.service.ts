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
  BoundedTtlCache,
  CRAWL_ENV,
  CrawlPolicyOverride,
  createHttpClient,
  DiscoveryMode,
  fetchSitemap,
  getEffectiveCrawlPolicy,
  getScrapeContext,
  htmlToPlainText,
  isCrawlPolicyError,
  markdownConverter,
  extractEmails,
  resolveCrawlPolicy,
  runWithScrapeContext,
  ScrapeContext,
  SitemapEntry,
} from '@ever-jobs/common';
import {
  SOFTY_ROOT_DOMAIN,
  SOFTY_SCHEME,
  SOFTY_OFFERS_PATH,
  SOFTY_OFFER_PATH,
  SOFTY_DEFAULT_RESULTS,
  SOFTY_HEADERS,
  SOFTY_OFFER_LINK_REGEX,
  SOFTY_PUBLISHED_REGEX,
  SOFTY_CONTRACT_REGEX,
  SOFTY_REMOTE_REGEX,
  SOFTY_BROWSER_USER_AGENT,
  SOFTY_CRAWL_POLICY,
  SOFTY_DESCRIPTION_MAX_CHARS,
  SOFTY_DETAIL_25_LIMIT,
  SOFTY_LASTMOD_AS_DATE_POSTED,
  SOFTY_SITEMAP_PATH,
} from './softy.constants';
import { readSoftyConfig } from './softy.config';
import {
  hasLegacySoftyLinks,
  looksLikeCurrentSoftyMarkup,
  parseSoftyDetailPage,
  parseSoftyListingPage,
  softyBaseUrl,
  softyListingPageUrl,
  softyOfferIdFromUrl,
  softyOfferUrl,
} from './softy.parser';
import { SoftyCardJob, SoftyConfig, SoftyDetail, SoftyJob } from './softy.types';

type SoftyClient = ReturnType<typeof createHttpClient>;

/** `ScraperInputDto.descriptionDepth` values. */
type SoftyDescriptionDepth = 'board' | 'detail-25' | 'detail-all';

const DISCOVERY_MODES: readonly DiscoveryMode[] = ['auto', 'sitemap', 'listing'];

/**
 * A Softy tenant is ONE DNS label (`acme` in `acme.softy.pro`). Anything else —
 * `x#`, `x/`, `x?`, `x@y`, `a.b` — would let a caller-supplied slug steer the
 * built URL (`https://${tenant}.softy.pro`) to another host.
 */
const SOFTY_TENANT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** State of one scrape. */
interface SoftyRun {
  client: SoftyClient;
  tenant: string;
  host: string;
  config: SoftyConfig;
  discovery: DiscoveryMode;
  depth?: SoftyDescriptionDepth;
  offset: number;
  wanted: number;
  format?: DescriptionFormat;
  /** Detail pages this scrape may fetch (cache hits are free). */
  detailBudget: number;
  detailFetches: number;
  consecutiveDetailFailures: number;
  /** Set once the server pushed back (429, cool-down…) — no further detail GETs. */
  stopDetails: boolean;
  signal?: AbortSignal;
  /** First failure worth reporting; turned into the response's diagnostic. */
  error?: unknown;
  /** A diagnostic for a result that is short without any failure (used when `error` is unset). */
  note?: ScrapeDiagnostics;
  cache: BoundedTtlCache<SoftyDetail> | null;
}

/** Result of one page GET: the HTML, a missing page (4xx / unknown host), or a failure. */
type FetchOutcome =
  | { kind: 'ok'; html: string }
  | { kind: 'missing'; status?: number }
  | { kind: 'failed'; error: unknown };

/**
 * Softy (softy.pro) ATS careers scraper — generic, multi-tenant (Specs 374, 1691).
 *
 * Softy (softy.pro, Dijon, France) powers each customer tenant's branded, public,
 * unauthenticated candidate-facing careers board on its own sub-domain of the shared
 * application host, keyed by the tenant slug (`https://{tenant}.softy.pro`).
 *
 * **Discovery** follows the resolved crawl policy's `discovery` (search caller
 * `crawl.discovery`, operator `sites.softy.discovery` / `hosts["*.softy.pro"]`,
 * `EVER_JOBS_CRAWL_DISCOVERY`; Spec 1690):
 *
 * - `sitemap`: GET `/sitemap.xml`, keep the `/offers/{ID}` entries newest `lastmod`
 *   first, skip `offset`, and read each detail page — one after another — until
 *   `resultsWanted` roles are built.
 * - `listing`: GET `/offers?page=1..N` (stopping at `resultsWanted`, a page with no new
 *   cards, the last linked page, or `SOFTY_MAX_LIST_PAGES`) and parse the cards; the
 *   legacy `/offres` + `/offre/{ID}-{slug}` parser is kept as a fallback for tenants
 *   still on the old markup. Detail pages then follow `descriptionDepth`.
 * - `auto` (default): `sitemap`, falling back to `listing` when the sitemap is missing,
 *   empty or unparseable; `listing` straight away for `descriptionDepth: 'board'` and
 *   whenever the detail budget is smaller than `offset + resultsWanted` (a sitemap
 *   offer needs its detail page to become a post; the listing returns the rest
 *   board-only). Explicit `sitemap` keeps the budget and reports a `partial`
 *   diagnostic when it shortened the result.
 *
 * **Detail pages** per `descriptionDepth`: `board` none, `detail-25` the first 25,
 * `detail-all`/unset all wanted (bounded by `SOFTY_MAX_DETAIL_FETCHES`). Always
 * sequential. Extracted fields are cached (`SOFTY_DETAIL_CACHE_MAX` entries,
 * `SOFTY_DETAIL_CACHE_TTL_MS`) keyed by `url|lastmod` (sitemap) or `url` (listing), so
 * a repeat search only re-reads offers whose `lastmod` changed.
 *
 * **Pacing and identity** belong to `HttpClient` and the plugin's crawl policy:
 * `softy.pro` as one bucket, one request in flight, ~1 request/second. Called outside
 * a scrape context (CLI, library, e2e tests), the plugin opens one itself with that
 * policy and the caller's `crawl`, so the same pacing applies. The browser UA this
 * plugin used to send is only *declared* now (UA mode `plugin` sends it).
 *
 * **Failures** degrade instead of throwing: an HTTP 4xx or unknown host → empty; a
 * 5xx / network failure → whatever was collected plus a diagnostic; a 429 or a
 * crawl-policy refusal (cool-down, queue timeout, egress) stops further requests for
 * the scrape and keeps the partial result with its diagnostic.
 */
@SourcePlugin({
  site: Site.SOFTY,
  name: 'Softy',
  category: 'ats',
  isAts: true,
  crawl: SOFTY_CRAWL_POLICY,
})
@Injectable()
export class SoftyService implements IScraper {
  private readonly logger = new Logger(SoftyService.name);

  /** Process-wide (the service is a singleton) cache of extracted detail fields. */
  private detailCache: BoundedTtlCache<SoftyDetail> | null = null;
  private detailCacheShape = '';

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Softy scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Softy tenant slug from input');
      return new JobResponseDto([]);
    }
    if (!SOFTY_TENANT_LABEL.test(tenant)) {
      this.logger.warn(`Softy: refusing tenant ${JSON.stringify(tenant.slice(0, 80))} (not a single DNS label)`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('bad_input', 'Softy tenant must be a single DNS label (letters, digits, hyphens)'),
      );
    }

    const resultsWanted = input.resultsWanted ?? SOFTY_DEFAULT_RESULTS;
    if (!(resultsWanted > 0)) {
      this.logger.log(`Softy: resultsWanted=${resultsWanted} for ${tenant}; nothing to fetch`);
      return new JobResponseDto([]);
    }

    const host = `${tenant}.${SOFTY_ROOT_DOMAIN}`;
    const ctx = this.scrapeContext();
    const discovery = this.resolveDiscovery(input, host, ctx);
    if (ctx) return this.scrapeTenant(input, tenant, host, resultsWanted, discovery);

    // Called outside JobsService (CLI, library, e2e tests): run inside a scrape context
    // of our own, so HttpClient applies this plugin's crawl policy (one request at a
    // time, ~1/s across softy.pro) and the caller's `crawl` object here as well.
    let started = false;
    const run = () => {
      started = true;
      return this.scrapeTenant(input, tenant, host, resultsWanted, discovery);
    };
    try {
      return await runWithScrapeContext(
        { site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: this.callerCrawl(input) },
        run,
      );
    } catch (err: any) {
      if (started) throw err;
      this.logger.debug(`Softy: scrape context unavailable (${err?.message ?? err}); running without one`);
      return run();
    }
  }

  /** One tenant scrape; never throws (failures become the response's diagnostic). */
  private async scrapeTenant(
    input: ScraperInputDto,
    tenant: string,
    host: string,
    resultsWanted: number,
    discovery: DiscoveryMode,
  ): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    // Content negotiation, plus the UA this plugin *declares*. HttpClient decides
    // which UA goes on the wire (Spec 1690 §4.2): the declared browser UA only when
    // the resolved UA mode is `plugin`; by default the honest Ever Jobs UA.
    client.setHeaders({ ...SOFTY_HEADERS, 'User-Agent': SOFTY_BROWSER_USER_AGENT });

    const config = readSoftyConfig();
    const depth = this.normaliseDepth(input.descriptionDepth);
    const run: SoftyRun = {
      client,
      tenant,
      host,
      config,
      discovery,
      depth,
      offset: Math.max(0, Math.floor(Number(input.offset) || 0)),
      wanted: Math.floor(resultsWanted),
      format: input.descriptionFormat,
      detailBudget: this.detailBudget(depth, config),
      detailFetches: 0,
      consecutiveDetailFailures: 0,
      stopDetails: false,
      signal: this.scrapeContext()?.signal,
      cache: this.getDetailCache(config),
    };

    const jobPosts: JobPostDto[] = [];
    try {
      this.logger.log(
        `Fetching Softy jobs for tenant: ${tenant} (discovery=${discovery}, depth=${depth ?? 'detail-all'})`,
      );
      await this.collect(run, jobPosts);

      if (jobPosts.length === 0 && run.error === undefined) {
        this.logger.log(`Softy tenant "${tenant}" has no open roles`);
      } else {
        this.logger.log(
          `Softy total: ${jobPosts.length} jobs for ${tenant} (${run.detailFetches} detail page(s) fetched)`,
        );
      }
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is inferred
      // as 'partial' upstream, so a mid-scrape failure is not mistaken for a complete board.
      return new JobResponseDto(
        jobPosts,
        run.error !== undefined ? classifyScrapeError(run.error) : run.note,
      );
    } catch (err: any) {
      this.logger.error(`Softy scrape error for ${tenant}: ${err?.message ?? err}`);
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /** Drop every cached detail page (e.g. after a tenant re-published its offers). */
  clearDetailCache(): void {
    this.detailCache?.clear();
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  /**
   * The discovery mode for this scrape (Spec 1690 §4.1 layers). Inside a scrape
   * context (`JobsService`), the context's resolved policy already includes the
   * caller's `crawl` object. Outside one (CLI / library / tests), the caller's
   * `input.crawl.discovery` wins directly, then the policy resolved for this site and
   * host (env, operator site/host layers). If the crawl-policy resolver is unavailable
   * the caller value, then `EVER_JOBS_CRAWL_DISCOVERY`, then `auto` apply.
   */
  private resolveDiscovery(input: ScraperInputDto, host: string, ctx: ScrapeContext | undefined): DiscoveryMode {
    const callerDiscovery = this.asDiscovery(this.callerCrawl(input)?.discovery);
    if (!ctx && callerDiscovery) return callerDiscovery;

    try {
      const policy = ctx
        ? getEffectiveCrawlPolicy(host)
        : resolveCrawlPolicy({ site: Site.SOFTY, host, plugin: SOFTY_CRAWL_POLICY });
      const resolved = this.asDiscovery(policy?.discovery);
      if (resolved) return resolved;
    } catch (err: any) {
      this.logger.debug(`Softy: crawl policy unavailable (${err?.message ?? err}); using fallbacks`);
    }

    return (
      this.asDiscovery(ctx?.caller?.discovery) ??
      callerDiscovery ??
      this.asDiscovery(process.env[CRAWL_ENV.DISCOVERY]) ??
      'auto'
    );
  }

  /** The search request's `crawl` object (Spec 1690 §5.2), when it carries one. */
  private callerCrawl(input: ScraperInputDto): CrawlPolicyOverride | undefined {
    const crawl = (input as ScraperInputDto & { crawl?: unknown }).crawl;
    return crawl && typeof crawl === 'object' ? (crawl as CrawlPolicyOverride) : undefined;
  }

  private asDiscovery(value: unknown): DiscoveryMode | null {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return (DISCOVERY_MODES as readonly string[]).includes(v) ? (v as DiscoveryMode) : null;
  }

  private normaliseDepth(value: unknown): SoftyDescriptionDepth | undefined {
    return value === 'board' || value === 'detail-25' || value === 'detail-all' ? value : undefined;
  }

  /** Detail pages a scrape may fetch: none for `board`, 25 for `detail-25`, else the cap. */
  private detailBudget(depth: SoftyDescriptionDepth | undefined, config: SoftyConfig): number {
    if (depth === 'board') return 0;
    if (depth === 'detail-25') return Math.min(SOFTY_DETAIL_25_LIMIT, config.maxDetailFetches);
    return config.maxDetailFetches;
  }

  private scrapeContext(): ScrapeContext | undefined {
    try {
      return getScrapeContext();
    } catch {
      return undefined;
    }
  }

  /** Run the chosen strategy, falling back from `sitemap` to `listing` in `auto`. */
  private async collect(run: SoftyRun, posts: JobPostDto[]): Promise<void> {
    if (this.isAborted(run)) return;
    // `board` wants no detail pages, and sitemap entries carry nothing but a URL, so
    // the listing is the only source of card data (1 request per 21 offers). The
    // same holds in `auto` whenever the detail budget cannot cover every wanted
    // offer (`detail-25` with resultsWanted 30, or more than SOFTY_MAX_DETAIL_FETCHES):
    // a sitemap offer without its detail page yields no post, while the listing
    // still returns it board-only — the requested depth never shrinks the result.
    const useListing =
      run.discovery === 'listing' ||
      run.depth === 'board' ||
      (run.discovery === 'auto' && run.detailBudget < run.offset + run.wanted);

    if (!useListing) {
      const entries = await this.discoverFromSitemap(run);
      if (entries && entries.length > 0) {
        await this.collectFromSitemap(run, entries, posts);
        return;
      }
      if (run.discovery === 'sitemap') {
        this.logger.log(`Softy: no usable sitemap for ${run.tenant} (discovery=sitemap, no listing fallback)`);
        return;
      }
      if (run.stopDetails) return; // the server pushed back — do not start on the listing
      this.logger.log(`Softy: no usable sitemap for ${run.tenant}; falling back to the listing`);
    }

    await this.collectFromListing(run, posts);
  }

  /**
   * The tenant's `/offers/{ID}` sitemap entries, newest `lastmod` first — or null when
   * the sitemap is missing or failed (empty when present but useless). In explicit
   * `sitemap` mode a failure becomes the scrape's diagnostic; in `auto` the listing
   * fallback takes over.
   */
  private async discoverFromSitemap(run: SoftyRun): Promise<SitemapEntry[] | null> {
    const url = `${softyBaseUrl(run.tenant)}${SOFTY_SITEMAP_PATH}`;
    try {
      return await fetchSitemap(run.client, url, {
        sortByLastmod: true,
        filter: (loc) => softyOfferIdFromUrl(loc, run.host) !== null,
        onError: (nested, err: any) =>
          this.logger.debug(`Softy nested sitemap ${nested} skipped: ${err?.message ?? err}`),
      });
    } catch (err: any) {
      if (this.isFatal(run, err)) {
        this.stopOnFatal(run, err, 'sitemap');
        return null;
      }
      if (run.discovery === 'sitemap' && run.error === undefined) run.error = err;
      const status = this.httpStatus(err);
      if (this.isMissing(err)) {
        this.logger.log(`Softy sitemap not available (HTTP ${status ?? 'n/a'}) for ${run.tenant}`);
      } else {
        this.logger.warn(`Softy sitemap fetch failed for ${run.tenant}: ${err?.message ?? err}`);
      }
      return null;
    }
  }

  /**
   * Sitemap discovery: detail pages in `lastmod` order until `wanted` roles are built.
   * An offer whose detail page the budget no longer covers (and is not cached)
   * yields no post; when that shortens the result, a `partial` diagnostic says so.
   */
  private async collectFromSitemap(run: SoftyRun, entries: SitemapEntry[], posts: JobPostDto[]): Promise<void> {
    let produced = 0;
    let overBudget = 0;
    for (let i = run.offset; i < entries.length && produced < run.wanted; i++) {
      if (this.isAborted(run)) break;
      const entry = entries[i];
      const id = softyOfferIdFromUrl(entry.loc, run.host);
      if (!id) continue;
      const url = softyOfferUrl(run.tenant, id);
      const key = `${url}|${entry.lastmodRaw ?? ''}`;
      if (!run.stopDetails && run.detailFetches >= run.detailBudget && !run.cache?.get(key)) {
        overBudget++;
        continue;
      }
      const detail = await this.getDetail(run, url, key);
      if (!detail) continue;
      try {
        const post = this.buildPost({ id, url, lastmod: entry.lastmod ?? null }, run, detail);
        if (post) {
          posts.push(post);
          produced++;
        }
      } catch (err: any) {
        this.logger.warn(`Error processing Softy role ${id}: ${err?.message ?? err}`);
      }
    }
    if (overBudget > 0 && produced < run.wanted) {
      const detail =
        `detail-page budget (${run.detailBudget}) exhausted: ${overBudget} sitemap offer(s) not returned; ` +
        'use crawl.discovery=listing (board-only beyond the budget) or a larger descriptionDepth / SOFTY_MAX_DETAIL_FETCHES';
      this.logger.warn(`Softy ${run.tenant}: ${detail}`);
      if (run.note === undefined) run.note = new ScrapeDiagnostics('partial', detail);
    }
  }

  /**
   * Listing discovery: `/offers?page=1..N`, then detail pages per `descriptionDepth`.
   * Tenants still on the legacy markup are read from `/offres` instead.
   */
  private async collectFromListing(run: SoftyRun, posts: JobPostDto[]): Promise<void> {
    const needed = run.offset + run.wanted;
    const cards: SoftyCardJob[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= run.config.maxListPages; page++) {
      if (this.isAborted(run)) break;
      let outcome: FetchOutcome;
      try {
        outcome = await this.fetchOutcome(run, softyListingPageUrl(run.tenant, page));
      } catch (err) {
        this.stopOnFatal(run, err, 'listing');
        break;
      }
      if (outcome.kind === 'failed') {
        if (run.error === undefined) run.error = outcome.error;
        break;
      }
      if (outcome.kind === 'missing') {
        if (page === 1) await this.collectLegacyIndex(run, cards, seen, needed);
        break;
      }

      const parsed = parseSoftyListingPage(outcome.html, run.tenant);
      if (page === 1 && parsed.cards.length === 0) {
        if (hasLegacySoftyLinks(outcome.html)) {
          this.addLegacyCards(run, outcome.html, cards, seen, needed);
        } else if (!looksLikeCurrentSoftyMarkup(outcome.html)) {
          await this.collectLegacyIndex(run, cards, seen, needed);
        }
        break;
      }

      let added = 0;
      for (const card of parsed.cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        cards.push(card);
        added++;
      }
      if (added === 0 || cards.length >= needed) break;
      // The pagination names the pages that exist; stop when none comes after this one.
      if (parsed.pages.length > 0 && !parsed.pages.some((p) => p > page)) break;
    }

    await this.emitCards(run, cards.slice(run.offset, needed), posts);
  }

  /** Legacy fallback: the single-page `/offres` index with `/offre/{ID}-{slug}` anchors. */
  private async collectLegacyIndex(
    run: SoftyRun,
    cards: SoftyCardJob[],
    seen: Set<string>,
    needed: number,
  ): Promise<void> {
    let outcome: FetchOutcome;
    try {
      outcome = await this.fetchOutcome(run, `${softyBaseUrl(run.tenant)}${SOFTY_OFFERS_PATH}`);
    } catch (err) {
      this.stopOnFatal(run, err, 'legacy index');
      return;
    }
    if (outcome.kind === 'failed') {
      if (run.error === undefined) run.error = outcome.error;
      return;
    }
    if (outcome.kind === 'missing') return;
    this.addLegacyCards(run, outcome.html, cards, seen, needed);
  }

  private addLegacyCards(
    run: SoftyRun,
    html: string,
    cards: SoftyCardJob[],
    seen: Set<string>,
    needed: number,
  ): void {
    for (const card of this.parseIndex(html, run.tenant)) {
      if (cards.length >= needed) break;
      const id = this.cleanText(card.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cards.push({ ...card, legacy: true });
    }
  }

  /** Build a post per card, reading detail pages one at a time within the budget. */
  private async emitCards(run: SoftyRun, cards: SoftyCardJob[], posts: JobPostDto[]): Promise<void> {
    for (const card of cards) {
      if (this.isAborted(run)) break;
      const url = this.cleanText(card.url);
      const detail = url && run.depth !== 'board' ? await this.getDetail(run, url, url) : null;
      try {
        const post = this.buildPost(card, run, detail);
        if (post) posts.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Softy role ${card.id}: ${err?.message ?? err}`);
      }
    }
  }

  // ── Detail pages ────────────────────────────────────────────────────────────

  /**
   * Extracted detail fields for `url`: from the cache when `key` is fresh, otherwise
   * one GET (sequential by construction — callers await each call) while the budget
   * lasts. Null when unavailable; never throws.
   */
  private async getDetail(run: SoftyRun, url: string, key: string): Promise<SoftyDetail | null> {
    const cached = run.cache?.get(key);
    if (cached) return cached;
    if (run.stopDetails || run.detailFetches >= run.detailBudget || this.isAborted(run)) return null;

    run.detailFetches++;
    let outcome: FetchOutcome;
    try {
      outcome = await this.fetchOutcome(run, url);
    } catch (err) {
      this.stopOnFatal(run, err, 'detail pages');
      return null;
    }

    if (outcome.kind === 'ok') {
      run.consecutiveDetailFailures = 0;
      const detail = parseSoftyDetailPage(outcome.html);
      if (detail) run.cache?.set(key, detail);
      return detail;
    }
    if (outcome.kind === 'missing') {
      run.consecutiveDetailFailures = 0;
      return null;
    }

    if (run.error === undefined) run.error = outcome.error;
    run.consecutiveDetailFailures++;
    const max = run.config.maxConsecutiveDetailFailures;
    if (max > 0 && run.consecutiveDetailFailures >= max) {
      run.stopDetails = true;
      this.logger.warn(
        `Softy: ${run.consecutiveDetailFailures} detail pages failed in a row for ${run.tenant}; ` +
          'not fetching more this scrape',
      );
    }
    return null;
  }

  private getDetailCache(config: SoftyConfig): BoundedTtlCache<SoftyDetail> | null {
    if (config.detailCacheMax <= 0) return null;
    const shape = `${config.detailCacheMax}:${config.detailCacheTtlMs}`;
    if (!this.detailCache || this.detailCacheShape !== shape) {
      this.detailCache = new BoundedTtlCache<SoftyDetail>(config.detailCacheMax, config.detailCacheTtlMs);
      this.detailCacheShape = shape;
    }
    return this.detailCache;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  /**
   * GET a page as text. An HTTP 4xx (other than 429), an unknown host or a robots.txt
   * refusal is `missing`; a 5xx / network error is `failed`. Throws only when the
   * scrape must stop: aborted, 429 after HttpClient's retries, or a crawl-policy
   * refusal (host cooling down, queue timeout, egress guard).
   */
  private async fetchOutcome(run: SoftyRun, url: string): Promise<FetchOutcome> {
    try {
      const response = await run.client.get<string>(url, { responseType: 'text' });
      if (typeof response?.data === 'string') return { kind: 'ok', html: response.data };
      this.logger.warn(`Softy: non-text body for ${url}; ignoring it`);
      return { kind: 'missing', status: response?.status };
    } catch (err: any) {
      if (this.isFatal(run, err)) throw err;
      const status = this.httpStatus(err);
      if (this.isRobotsRefusal(err)) {
        if (run.error === undefined) run.error = err;
        this.logger.warn(`Softy: robots.txt disallows ${url}`);
        return { kind: 'missing' };
      }
      if (this.isMissing(err)) {
        this.logger.warn(`Softy page not found (HTTP ${status ?? err?.code ?? 'n/a'}) for ${run.tenant}: ${url}`);
        return { kind: 'missing', status };
      }
      // 5xx / network — degrade gracefully rather than throwing.
      this.logger.warn(`Softy fetch failed for ${run.tenant} (${url}): ${err?.message ?? err}`);
      return { kind: 'failed', error: err };
    }
  }

  private httpStatus(err: any): number | undefined {
    const status = err?.response?.status ?? err?.status;
    return typeof status === 'number' ? status : undefined;
  }

  /** 4xx other than 429, or a host that does not resolve (unknown tenant). */
  private isMissing(err: any): boolean {
    const status = this.httpStatus(err);
    if (status !== undefined) return status >= 400 && status < 500 && status !== 429;
    return err?.code === 'ENOTFOUND';
  }

  private isRobotsRefusal(err: any): boolean {
    return isCrawlPolicyError(err) && err.code === 'ERR_CRAWL_ROBOTS_DISALLOWED';
  }

  /** Errors after which this scrape sends nothing more to Softy. */
  private isFatal(run: SoftyRun, err: any): boolean {
    if (this.isAborted(run)) return true;
    if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError' || err?.name === 'CanceledError') return true;
    if (this.httpStatus(err) === 429) return true;
    return isCrawlPolicyError(err) && !this.isRobotsRefusal(err);
  }

  private stopOnFatal(run: SoftyRun, err: any, stage: string): void {
    run.stopDetails = true;
    if (run.error === undefined) run.error = err;
    if (!this.isAborted(run)) {
      this.logger.warn(`Softy stopped at ${stage} for ${run.tenant}: ${err?.message ?? err}`);
    }
  }

  private isAborted(run: SoftyRun): boolean {
    return run.signal?.aborted === true;
  }

  // ── Mapping ─────────────────────────────────────────────────────────────────

  private buildPost(card: SoftyCardJob, run: SoftyRun, detail: SoftyDetail | null): JobPostDto | null {
    const job = this.normaliseJob(card, run.tenant, detail, run.config);
    return this.processJob(job, run.tenant, run.format);
  }

  /**
   * Parse the server-rendered index HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical detail links
   * (`/offre/{ID}-{title-slug}`) and read the labelled card text immediately around
   * each link (location, contract type, "Mise en ligne le …").
   */
  private parseIndex(html: string, tenant: string): SoftyCardJob[] {
    const out: SoftyCardJob[] = [];
    const byId = new Map<string, SoftyCardJob>();

    SOFTY_OFFER_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SOFTY_OFFER_LINK_REGEX.exec(html)) !== null) {
      const [, id, slug] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const cleanSlug = this.deslugTitleSlug(slug);
      const url = `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}${SOFTY_OFFER_PATH}${jobId}-${this.cleanText(slug) ?? ''}`;

      const windowText = this.cardWindow(html, match.index);

      const card: SoftyCardJob = {
        id: jobId,
        slug: cleanSlug,
        url,
        title: this.titleFromSlug(slug),
        location: this.locationFromWindow(windowText),
        contractType: this.contractFromWindow(windowText),
        publishedAt: this.publishedFromWindow(windowText),
      };

      byId.set(jobId, card);
      out.push(card);
    }

    return out;
  }

  /**
   * Extract a window of plain text around a detail link, used to recover the card's
   * labelled fields. The card renders its fields close to its anchor, so a bounded
   * slice on either side captures them without bleeding into siblings.
   */
  private cardWindow(html: string, index: number): string {
    const start = Math.max(0, index - 200);
    const end = Math.min(html.length, index + 900);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /** Read the "Mise en ligne le DD/MM/YYYY" date out of a card window, if present. */
  private publishedFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const m = SOFTY_PUBLISHED_REGEX.exec(windowText);
    return m ? m[0] : null;
  }

  /** Read the contract-type token (CDI / CDD / Apprentissage / Stage …) from a window. */
  private contractFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const m = SOFTY_CONTRACT_REGEX.exec(windowText);
    return m ? this.cleanText(m[0]) : null;
  }

  /**
   * Best-effort recovery of the location city from a card window. The contract token
   * and the "Mise en ligne" line are stripped; the remaining short text token nearest
   * the anchor is treated as the location. Returns null when nothing usable remains.
   */
  private locationFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    let text = windowText
      .replace(SOFTY_PUBLISHED_REGEX, ' ')
      .replace(/\bMise\s+en\s+ligne\b/gi, ' ')
      .replace(SOFTY_CONTRACT_REGEX, ' ');
    // Collapse whitespace and drop obvious UI chrome tokens.
    text = text
      .replace(/\b(Postuler|Voir l'offre|Partager|Retour|Offres|Accueil)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) return null;
    // A French city is typically a short capitalised token (optionally hyphenated /
    // accented). Pick the first such token-run, bounded to keep it from grabbing a
    // whole sentence.
    const m =
      /([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:[\s-][A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,3})/.exec(
        text,
      );
    const candidate = m ? this.cleanText(m[1]) : null;
    if (!candidate) return null;
    // Guard against accidentally capturing the title; keep short location-like tokens.
    return candidate.length <= 60 ? candidate : null;
  }

  /**
   * Build a normalised SoftyJob from a card (listing card, legacy card, or a sitemap
   * entry) plus the fields read from its detail page. Card fields win; the detail page
   * fills the gaps. `datePosted` comes from "Mise en ligne le …", else (sitemap
   * discovery) from the entry's `lastmod` unless `SOFTY_LASTMOD_AS_DATE_POSTED=false`.
   */
  private normaliseJob(
    card: SoftyCardJob,
    tenant: string,
    detail: SoftyDetail | null,
    config?: SoftyConfig,
  ): SoftyJob {
    const jobId = this.cleanText(card.id) ?? '';
    const title = this.cleanText(card.title) ?? this.cleanText(detail?.title);
    const locations = (card.locations?.length ? card.locations : detail?.locations) ?? [];
    const locationText = this.cleanText(card.location) ?? this.cleanText(locations[0]);
    const { city, state, country } = this.splitLocation(locationText);
    const contractType = this.cleanText(card.contractType) ?? this.cleanText(detail?.contractType);
    const schedule = this.cleanText(card.schedule) ?? this.cleanText(detail?.schedule);
    const badges = [...(card.badges ?? []), ...(detail?.badges ?? [])];

    let datePosted = this.parseDate(card.publishedAt) ?? this.parseDate(detail?.publishedAt);
    const lastmodAsDate = config?.lastmodAsDatePosted ?? SOFTY_LASTMOD_AS_DATE_POSTED;
    if (!datePosted && lastmodAsDate && card.lastmod && !Number.isNaN(card.lastmod.getTime())) {
      datePosted = card.lastmod.toISOString().slice(0, 10);
    }

    const isRemote =
      this.detectRemote(title, locationText, contractType) ||
      [...locations, ...badges].some((value) => SOFTY_REMOTE_REGEX.test(value));

    return {
      jobId,
      url: this.cleanText(card.url) ?? this.buildJobUrl(tenant, card),
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      employmentType: this.normaliseEmploymentType(contractType ?? schedule),
      schedule,
      datePosted,
      isRemote,
      description: this.cleanText(detail?.description) ? (detail?.description as string) : null,
      descriptionIsHtml: detail?.descriptionIsHtml ?? false,
    };
  }

  /** Map a normalised SoftyJob → JobPostDto. */
  private processJob(
    job: SoftyJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    // Prefer the detail-page body as the description; fall back to the location line.
    const source = job.description ?? job.locationText ?? null;
    const description = this.formatDescription(
      source,
      format,
      job.description ? job.descriptionIsHtml === true : false,
    );

    return new JobPostDto({
      id: `softy-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SOFTY,
      atsId,
      atsType: 'softy',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Render the description per `descriptionFormat`, capped at
   * `SOFTY_DESCRIPTION_MAX_CHARS`. HTML input (the detail page's `.prose` sections,
   * `h2` headings kept) becomes HTML / Markdown / plain text. Plain-text input (the
   * pre-1691 path: `og:description`, a legacy page's text, or the location line) is
   * treated as before: HTML returns it as is, Markdown passes it through the
   * converter, plain strips any residual markup.
   */
  private formatDescription(
    text: string | null,
    format?: DescriptionFormat,
    isHtml = false,
  ): string | null {
    if (!text) return null;
    let out: string | null;
    if (isHtml) {
      if (format === DescriptionFormat.HTML) out = text;
      else if (format === DescriptionFormat.MARKDOWN) out = markdownConverter(text) ?? htmlToPlainText(text);
      else out = htmlToPlainText(text);
    } else if (format === DescriptionFormat.HTML) {
      out = text;
    } else if (format === DescriptionFormat.MARKDOWN) {
      out = markdownConverter(text) ?? text;
    } else {
      out = htmlToPlainText(text) ?? text;
    }
    if (!out) return null;
    return out.length > SOFTY_DESCRIPTION_MAX_CHARS ? out.slice(0, SOFTY_DESCRIPTION_MAX_CHARS) : out;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board
   * URL passed as the slug is reduced to its tenant sub-domain label); a `companyUrl`
   * on a `softy.pro` host has the tenant taken from its leading sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL / host as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SOFTY_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Softy URL. The candidate-facing forms are
   * `https://{tenant}.softy.pro/offres` and
   * `https://{tenant}.softy.pro/offre/{ID}-{slug}`; the tenant is the leading
   * sub-domain label of a `softy.pro` host.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(`.${SOFTY_ROOT_DOMAIN}`) && hostname !== SOFTY_ROOT_DOMAIN) {
        return '';
      }
      const label = hostname.slice(0, hostname.length - SOFTY_ROOT_DOMAIN.length).replace(/\.$/, '');
      // Strip a single leading sub-domain label; ignore the bare apex / `www`.
      const firstLabel = label.split('.').filter((s) => s.length > 0)[0];
      if (!firstLabel || firstLabel === 'www') return '';
      return firstLabel.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Build the public detail / apply URL for a role from its parts: the legacy
   * `/offre/{ID}-{slug}` form for legacy cards (or any card with a slug), otherwise the
   * canonical `/offers/{ID}`.
   */
  private buildJobUrl(tenant: string, card: SoftyCardJob): string {
    const id = this.cleanText(card.id) ?? '';
    const slug = this.cleanText(card.slug);
    if (!card.legacy && !slug) return softyOfferUrl(tenant, id);
    return `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}${SOFTY_OFFER_PATH}${id}-${slug ?? ''}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `manager-it-workplace-h-f`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned
      .replace(/[-_]+/g, ' ')
      .replace(/\bh\s*f\b/gi, 'H/F')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Normalise a raw title slug for storage (lower-case, dash-separated). */
  private deslugTitleSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. Softy renders a single free-text location city
   * (e.g. "Toulouse"); we keep it as the city, best-effort.
   */
  private extractLocation(job: SoftyJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Comma-separated tail is treated as the country; the head as the city.
   * Softy tenants are French, so a bare city line yields just the city.
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

  /** Detect remote / télétravail roles from the title, location, or contract text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    contractType: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, contractType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SOFTY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote"/"Télétravail" marker, not a place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|t[ée]l[ée]travail|distanciel)$/i.test(value.trim());
  }

  /**
   * Normalise a Softy contract-type token (e.g. "CDI", "Apprentissage - 24 Mois",
   * "Stage - 4 Mois") into a readable, trimmed label. Known short codes are kept
   * upper-case; longer labels are title-cased.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const upper = cleaned.toUpperCase();
    if (upper === 'CDI' || upper === 'CDD') return upper;
    const spaced = cleaned.replace(/\s{2,}/g, ' ').trim();
    return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a "Mise en ligne le DD/MM/YYYY" value into a YYYY-MM-DD string. The Softy
   * date is day-first (French locale); a value that does not match yields null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = SOFTY_PUBLISHED_REGEX.exec(cleaned);
    if (!m) return null;
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    const monthNum = Number(month);
    const dayNum = Number(day);
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
    return `${year}-${month}-${day}`;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
