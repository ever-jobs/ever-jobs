import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  preferRefusalError,
  ScrapeDiagnostics,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  BoundedTtlCache,
  CallerOverridePolicy,
  CallerOverridesSource,
  CRAWL_ENV,
  CrawlPolicyLayer,
  CrawlPolicyOverride,
  createHttpClient,
  decodeSitemapBody,
  DiscoveryMode,
  fetchSitemap,
  getEffectiveCrawlPolicy,
  getScrapeContext,
  htmlToPlainText,
  isCrawlPolicyError,
  isServerStruggling,
  markdownConverter,
  extractEmails,
  parseLocationText,
  resolveCallerOverrides,
  resolveCrawlPolicy,
  runWithScrapeContext,
  ScrapeContext,
  SITEMAP_DEFAULT_MAX_BYTES,
  SitemapEntry,
  SitemapHttp,
} from '@ever-jobs/common';
import {
  SOFTY_ROOT_DOMAIN,
  SOFTY_OFFERS_PATH,
  SOFTY_OFFER_PATH,
  SOFTY_DEFAULT_RESULTS,
  SOFTY_ENV,
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
  SOFTY_LEGACY_INDEX_PATH,
  SOFTY_SITEMAP_CACHE_MAX,
  SOFTY_SITEMAP_PATH,
  SOFTY_UNKNOWN_TENANT_CACHE_MAX,
  SOFTY_UNKNOWN_TENANT_TTL_MAX_MS,
} from './softy.constants';
import { readSoftyConfig } from './softy.config';
import {
  hasLegacySoftyLinks,
  looksLikeCurrentSoftyMarkup,
  looksLikeSoftyChallenge,
  parseSoftyDetailPage,
  parseSoftyListingPage,
  softyBaseUrl,
  softyListingPageUrlFrom,
  softyOfferIdFromUrl,
  softyOfferUrlFrom,
  softySitemapBodyKind,
} from './softy.parser';
import { SoftyCardJob, SoftyConfig, SoftyDetail, SoftyJob } from './softy.types';

type SoftyClient = ReturnType<typeof createHttpClient>;

/** `ScraperInputDto.descriptionDepth` values. */
type SoftyDescriptionDepth = 'board' | 'detail-25' | 'detail-all';

const DISCOVERY_MODES: readonly DiscoveryMode[] = ['auto', 'sitemap', 'listing'];

/**
 * Crawl-policy layers set by the OPERATOR (Spec 1715 FR-11): an operator-level
 * `discovery: 'sitemap'` beats `descriptionDepth: 'board'`; a caller's does not (D5).
 */
const OPERATOR_LAYERS: readonly CrawlPolicyLayer[] = ['env-global', 'operator-site', 'operator-host'];

/** HTTP answers that refuse us outright (Spec 1715 FR-6): a stop with `blocked`. */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([401, 403, 407]);

/**
 * A Softy tenant is ONE DNS label (`acme` in `acme.softy.pro`). Anything else —
 * `x#`, `x/`, `x?`, `x@y`, `a.b` — would let a caller-supplied slug steer the
 * built URL (`https://${tenant}.softy.pro`) to another host.
 */
const SOFTY_TENANT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a scrape stopped early, when the site pushed back (Spec 1715 §7.5). */
type SoftyStopReason = 'blocked' | 'rate_limited';

/** State of one scrape. */
interface SoftyRun {
  client: SoftyClient;
  tenant: string;
  /** The tenant's origin (`https://{tenant}.softy.pro`); every URL is built on it. */
  origin: string;
  /** The origin's hostname (no port). */
  host: string;
  config: SoftyConfig;
  discovery: DiscoveryMode;
  /** `discovery` came from an operator layer (env, operator site / host). */
  operatorDiscovery: boolean;
  /**
   * The effective caller-override mode of this scrape and the layer that set it
   * (Spec 1714 `resolveCallerOverrides`): `stricter` / `none` = callers may not
   * loosen the Softy policy (the site owner's lock by default).
   */
  callerLock: { mode: CallerOverridePolicy; source: CallerOverridesSource };
  /**
   * `auto` stayed on the sitemap although the detail budget is short of
   * `resultsWanted`, because the caller drove the shortfall under a lock (round 2,
   * A1): the `partial` note says so.
   */
  budgetKeptOnSitemap: boolean;
  depth?: SoftyDescriptionDepth;
  offset: number;
  wanted: number;
  format?: DescriptionFormat;
  /** Detail pages this scrape may fetch (cache hits are free). */
  detailBudget: number;
  /** Detail GETs this scrape may attempt: `min(detailBudget, wanted + SOFTY_DETAIL_ATTEMPT_SLACK)` (FR-7). */
  detailAttemptCap: number;
  detailFetches: number;
  consecutiveDetailFailures: number;
  /** No further detail GETs (failures in a row, a failed listing page, or a stop). */
  stopDetails: boolean;
  /** No further request of any kind (Spec 1715 §7.3 / §7.4 "stop"). */
  stopped: boolean;
  /** The response's diagnostic when the stop names its reason (blocked, rate_limited, unknown tenant…). */
  stopDiagnostics?: ScrapeDiagnostics;
  /** Network requests this scrape sent (or tried to): the first one may reveal an unknown tenant. */
  requests: number;
  signal?: AbortSignal;
  /** The most telling failure (`preferRefusalError`); turned into the response's diagnostic. */
  error?: unknown;
  /** A diagnostic for a result that is short without any failure (used when `error` is unset). */
  note?: ScrapeDiagnostics;
  cache: BoundedTtlCache<SoftyDetail> | null;
}

/** Result of one page GET (Spec 1715 §7.4). `stop`: the scrape has stopped (the reason is on the run). */
type FetchOutcome =
  | { kind: 'ok'; html: string; fetchedAt: string }
  | { kind: 'missing'; status?: number }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stop' };

/**
 * Result of the sitemap stage (Spec 1715 §7.3). `fallback`: `auto` may read list
 * pages. `listedAt`: when the sitemap that listed the entries was fetched from the
 * network (ISO-8601 UTC), also for entries served from the sitemap cache.
 */
type SitemapStage =
  | { kind: 'entries'; entries: SitemapEntry[]; listedAt: string }
  | { kind: 'fallback' }
  | { kind: 'stop' };

/** A detail page's fields, and when the network answered it (unset for a cache hit). */
interface DetailResult {
  detail: SoftyDetail | null;
  fetchedAt?: string;
}

/**
 * A sitemap-cache entry: the offer entries of one tenant, when they were cached
 * (`at`, the TTL clock) and when the network answered the sitemap (`listedAt`,
 * ISO-8601 UTC — what `jobUrlListedAt` carries on a cache hit).
 */
interface CachedSitemap {
  entries: SitemapEntry[];
  at: number;
  listedAt: string;
}

/** Thrown by the sitemap adapter once the scrape has stopped: nothing is sent. */
class SoftyStoppedError extends Error {
  constructor() {
    super('Softy scrape stopped; request not sent');
    this.name = 'SoftyStoppedError';
  }
}

/** A 2xx page that is a bot wall rather than Softy content (Spec 1715 FR-6): `blocked`. */
class SoftyChallengeError extends Error {
  constructor(readonly url: string) {
    super(`Softy answered ${url} with a bot-challenge page (blocked)`);
    this.name = 'SoftyChallengeError';
  }
}

/** A sitemap body that could not be decoded (size cap, bad gzip): "could not be parsed". */
class SoftySitemapDecodeError extends Error {
  constructor(url: string, readonly original: unknown) {
    super(`Softy sitemap ${url} could not be decoded: ${(original as Error)?.message ?? String(original)}`);
    this.name = 'SoftySitemapDecodeError';
  }
}

/**
 * Softy (softy.pro) ATS careers scraper — generic, multi-tenant (Specs 374, 1691, 1715).
 *
 * Softy (softy.pro, Dijon, France) powers each customer tenant's branded, public,
 * unauthenticated candidate-facing careers board on its own sub-domain of the shared
 * application host, keyed by the tenant slug (`https://{tenant}.softy.pro`). Every
 * tenant is served by ONE server, whose operator asked for an honest UA, one request
 * at a time at ~1/s, no proxy rotation, back-off on 429 / `Retry-After` and when the
 * server struggles, and discovery from `/sitemap.xml` rather than list pages.
 *
 * **Discovery** follows the resolved crawl policy's `discovery` — always resolved
 * inside a scrape context, so the site-owner lock (`callerOverrides: 'stricter'`, Spec
 * 1714) applies to a caller's `crawl.discovery` on every path (a caller may only
 * choose `sitemap`):
 *
 * - `sitemap`: GET `/sitemap.xml` (cached per tenant `SOFTY_SITEMAP_CACHE_TTL_MS`),
 *   keep one `/offers/{ID}` entry per offer, newest `lastmod` first, skip `offset`,
 *   and read each detail page — one after another — until `resultsWanted` roles are
 *   built.
 * - `listing`: GET `/offers?page=1..N` (stopping at `resultsWanted`, a page with no new
 *   cards, the last linked page, or `SOFTY_MAX_LIST_PAGES`; `0` disables list pages)
 *   and parse the cards; the legacy `/offre/{ID}-{slug}` parser is kept as a fallback
 *   for tenants still on the old markup (index read at `/offers`, detail pages at
 *   `/offers/{ID}`). Detail pages then follow `descriptionDepth`.
 * - `auto` (default): `sitemap`, falling back to `listing` only as
 *   `SOFTY_SITEMAP_FALLBACK` allows (default `empty`: the sitemap answered but held no
 *   offer, or could not be parsed); `listing` straight away for `descriptionDepth:
 *   'board'` (unless the operator chose `sitemap`; D5 — fewer requests than the
 *   sitemap plus a detail page per offer). A detail budget smaller than
 *   `resultsWanted` reads list pages only when the operator allows it (an operator
 *   `auto`, the lock lifted, `SOFTY_MAX_DETAIL_FETCHES=0`, or
 *   `SOFTY_LEGACY=caller-listing`); under the caller lock it stays on the sitemap
 *   and returns what the budget allows with a `partial` note (round 2, A1).
 *   Explicit `sitemap` never falls back.
 *
 * **Push-back stops the scrape** (Spec 1715 §7.3 / §7.4): 401/403/407 or a challenge
 * page → `blocked`; 429 / 503 → `rate_limited`; a 5xx / timeout → a diagnostic (on
 * detail pages after `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES`, default 1; on a nested
 * sitemap too, unless `SOFTY_LEGACY=nested-skip` or `SOFTY_SITEMAP_FALLBACK=any-error`
 * skips it); an unknown tenant (`ENOTFOUND` on the first request) → `bad_input`, remembered for
 * `SOFTY_UNKNOWN_TENANT_TTL_MS`. Nothing more is sent to Softy in that scrape; what
 * was collected is returned with the diagnostic. Detail GETs are capped at
 * `resultsWanted + SOFTY_DETAIL_ATTEMPT_SLACK`.
 *
 * **Detail pages** per `descriptionDepth`: `board` none, `detail-25` the first 25,
 * `detail-all`/unset all wanted (bounded by `SOFTY_MAX_DETAIL_FETCHES`). Always
 * sequential. Extracted fields are cached (`SOFTY_DETAIL_CACHE_MAX` entries) keyed by
 * `url|lastmod` (sitemap; no expiry by default) or `url` (listing; 6 h), so a repeat
 * search only re-reads offers whose `lastmod` changed. A post whose page this scrape
 * fetched carries `jobUrlFetchedAt`, and every post taken from a sitemap carries
 * `jobUrlListedAt` (when that sitemap was fetched from the network, also on a
 * sitemap-cache hit), so `?liveness=true` need not fetch it again.
 *
 * **Pacing and identity** belong to `HttpClient` and the crawl policy (the manifest
 * `SOFTY_CRAWL_POLICY`, and the `*.softy.pro` builtin host policy for every other
 * plugin): `softy.pro` as one bucket, one request in flight, ≥ 1 s between starts and
 * ≥ 0.5 s idle after each answer, plus a 1 s `minIntervalFloorMs` on this client.
 * Called outside a scrape context (CLI, library, e2e tests), the plugin opens one
 * itself with that policy and the caller's `crawl`, so the same pacing applies. The
 * browser UA this plugin used to send is only *declared* now (UA mode `plugin` sends it).
 *
 * `SOFTY_LEGACY` (comma list or `all`) restores individual pre-1715 behaviours
 * (`SOFTY_LEGACY_TOKENS`).
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

  /** Per-tenant sitemap cache (Spec 1715 FR-12), keyed by origin. */
  private sitemapCache: BoundedTtlCache<CachedSitemap> | null = null;

  /** Unknown tenants (host did not resolve), keyed by origin → when it was seen (FR-5). */
  private unknownTenants: BoundedTtlCache<number> | null = null;

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

    if (this.scrapeContext()) return this.scrapeTenant(input, tenant, resultsWanted);

    // Called outside JobsService (CLI, library, e2e tests): run inside a scrape context
    // of our own, so HttpClient applies this plugin's crawl policy (one request at a
    // time, ~1/s across softy.pro) and the caller's `crawl` object here as well — and
    // discovery is resolved INSIDE it (Spec 1715 FR-3), so the site-owner lock filters
    // the caller's `crawl.discovery` like every other field.
    let started = false;
    const run = () => {
      started = true;
      return this.scrapeTenant(input, tenant, resultsWanted);
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
  private async scrapeTenant(input: ScraperInputDto, tenant: string, resultsWanted: number): Promise<JobResponseDto> {
    const config = readSoftyConfig();
    const origin = this.tenantOrigin(tenant);
    const host = hostOf(origin);

    // FR-5: a tenant whose host did not resolve a moment ago costs nothing now.
    if (this.isKnownUnknownTenant(config, origin)) {
      this.logger.log(`Softy: tenant "${tenant}" did not resolve recently; not asking again`);
      return new JobResponseDto([], this.unknownTenantDiagnostics(tenant, host, config));
    }

    const { mode: discovery, operator: operatorDiscovery } = this.resolveDiscovery(input, host);
    const callerLock = this.resolveCallerLock(host);
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
      // FR-2 (audit G3): no policy layer — a caller's `rateDelayMin: 0` included —
      // spaces two Softy requests closer than 1 s. SOFTY_LEGACY=no-interval-floor → 0 (pre-1715).
      minIntervalFloorMs: config.minIntervalFloorMs,
    });
    // Content negotiation, plus the UA this plugin *declares*. HttpClient decides
    // which UA goes on the wire (Spec 1690 §4.2): the declared browser UA only when
    // the resolved UA mode is `plugin`; by default the honest Ever Jobs UA.
    client.setHeaders({ ...SOFTY_HEADERS, 'User-Agent': SOFTY_BROWSER_USER_AGENT });

    const depth = this.normaliseDepth(input.descriptionDepth);
    const wanted = Math.floor(resultsWanted);
    const detailBudget = this.detailBudget(depth, config);
    const run: SoftyRun = {
      client,
      tenant,
      origin,
      host,
      config,
      discovery,
      operatorDiscovery,
      callerLock,
      budgetKeptOnSitemap: false,
      depth,
      offset: Math.max(0, Math.floor(Number(input.offset) || 0)),
      wanted,
      format: input.descriptionFormat,
      detailBudget,
      detailAttemptCap: Math.min(detailBudget, wanted + config.detailAttemptSlack),
      detailFetches: 0,
      consecutiveDetailFailures: 0,
      stopDetails: false,
      stopped: false,
      requests: 0,
      signal: this.scrapeContext()?.signal,
      cache: this.getDetailCache(config),
    };

    const jobPosts: JobPostDto[] = [];
    try {
      this.logger.log(
        `Fetching Softy jobs for tenant: ${tenant} (discovery=${discovery}, depth=${depth ?? 'detail-all'})`,
      );
      await this.collect(run, jobPosts);

      const diagnostics = this.diagnosticsOf(run);
      if (jobPosts.length === 0 && diagnostics === undefined) {
        this.logger.log(`Softy tenant "${tenant}" has no open roles`);
      } else {
        this.logger.log(
          `Softy total: ${jobPosts.length} jobs for ${tenant} (${run.detailFetches} detail page(s) fetched)`,
        );
      }
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is inferred
      // as 'partial' upstream, so a mid-scrape failure is not mistaken for a complete board.
      return new JobResponseDto(jobPosts, diagnostics);
    } catch (err: any) {
      this.logger.error(`Softy scrape error for ${tenant}: ${err?.message ?? err}`);
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * The response's diagnostic (Spec 1715 FR-8, §7.5): the stop's own diagnostic
   * (`blocked`, `rate_limited`, an unknown tenant…), else the most telling error
   * (`classifyScrapeError(run.error)`), else a `partial` / `bad_input` note.
   */
  private diagnosticsOf(run: SoftyRun): ScrapeDiagnostics | undefined {
    if (run.stopDiagnostics) return run.stopDiagnostics;
    if (run.error !== undefined) return classifyScrapeError(run.error);
    return run.note;
  }

  /**
   * The tenant's origin, `https://{tenant}.softy.pro` (Spec 1715 D6). A test seam
   * only: the integration test subclasses it to point at a loopback server. It is
   * never derived from input (the tenant is a validated DNS label), so it opens no
   * SSRF path.
   */
  protected tenantOrigin(tenant: string): string {
    return softyBaseUrl(tenant);
  }

  /** Drop every cached detail page (e.g. after a tenant re-published its offers). */
  clearDetailCache(): void {
    this.detailCache?.clear();
  }

  /** Drop the detail, sitemap and unknown-tenant caches (Spec 1715). */
  clearCaches(): void {
    this.detailCache?.clear();
    this.sitemapCache?.clear();
    this.unknownTenants?.clear();
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  /**
   * The discovery mode for this scrape (Spec 1690 §4.1 layers), and whether an
   * operator layer chose it (FR-11). Resolved through the crawl policy — the scrape
   * context's (`JobsService`'s, or the plugin's own), which includes the caller's
   * `crawl` filtered by the site-owner lock (Spec 1715 FR-3); without a context, the
   * same resolution with the caller's `crawl` as the caller layer. If the resolver is
   * unavailable the caller value, then `EVER_JOBS_CRAWL_DISCOVERY`, then `auto` apply.
   */
  private resolveDiscovery(input: ScraperInputDto, host: string): { mode: DiscoveryMode; operator: boolean } {
    const ctx = this.scrapeContext();
    const caller = this.callerCrawl(input);
    try {
      const policy = ctx
        ? getEffectiveCrawlPolicy(host)
        : resolveCrawlPolicy({ site: Site.SOFTY, host, plugin: SOFTY_CRAWL_POLICY, ...(caller ? { caller } : {}) });
      const resolved = this.asDiscovery(policy?.discovery);
      if (resolved) {
        const layer = policy?.provenance?.discovery;
        return { mode: resolved, operator: layer !== undefined && OPERATOR_LAYERS.includes(layer) };
      }
    } catch (err: any) {
      this.logger.debug(`Softy: crawl policy unavailable (${err?.message ?? err}); using fallbacks`);
    }

    const fromCaller = this.asDiscovery(ctx?.caller?.discovery) ?? this.asDiscovery(caller?.discovery);
    if (fromCaller) return { mode: fromCaller, operator: false };
    const fromEnv = this.asDiscovery(process.env[CRAWL_ENV.DISCOVERY]);
    if (fromEnv) return { mode: fromEnv, operator: true };
    return { mode: 'auto', operator: false };
  }

  /**
   * The effective caller-override mode of this scrape and its source (Spec 1714
   * `resolveCallerOverrides`): the same computation that filters the caller's `crawl`
   * — inside a scrape context from the context's site and plugin layer, outside it
   * from the Softy manifest — plus the builtin `*.softy.pro` host policy and any
   * operator `sites.softy` / `hosts[…]` value. If the resolver is unavailable, the
   * manifest's own lock applies (fail safe).
   */
  private resolveCallerLock(host: string): SoftyRun['callerLock'] {
    const ctx = this.scrapeContext();
    try {
      const resolved = resolveCallerOverrides(
        ctx ? { site: ctx.site, host, plugin: ctx.plugin } : { site: Site.SOFTY, host, plugin: SOFTY_CRAWL_POLICY },
      );
      return { mode: resolved.mode, source: resolved.source };
    } catch (err: any) {
      this.logger.debug(`Softy: caller-override mode unavailable (${err?.message ?? err}); assuming the manifest's lock`);
      return { mode: SOFTY_CRAWL_POLICY.callerOverrides ?? 'stricter', source: 'plugin' };
    }
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

  /** Run the chosen strategy, falling back from `sitemap` to `listing` in `auto` as allowed. */
  private async collect(run: SoftyRun, posts: JobPostDto[]): Promise<void> {
    if (this.isAborted(run)) return;
    const legacy = run.config.legacy;
    const listPagesOff = run.config.maxListPages === 0;

    // FR-11: SOFTY_MAX_LIST_PAGES=0 disables list pages entirely.
    if (listPagesOff && run.discovery === 'listing') {
      const detail =
        `discovery 'listing' for ${run.tenant}, but list pages are disabled (${SOFTY_ENV.MAX_LIST_PAGES}=0); ` +
        'nothing requested';
      this.logger.warn(`Softy: ${detail}`);
      run.note = new ScrapeDiagnostics('bad_input', detail);
      return;
    }

    // FR-11 / D5: an OPERATOR's `sitemap` beats `descriptionDepth: 'board'` (the sitemap
    // path then returns what the board budget allows — cached offers — with a note).
    // SOFTY_LEGACY=board-over-sitemap restores the pre-1715 precedence.
    const operatorSitemap = run.discovery === 'sitemap' && run.operatorDiscovery && !legacy.has('board-over-sitemap');
    // FR-9 (audit G19): offset entries cost no detail fetch on the sitemap path, so only
    // `resultsWanted` counts. SOFTY_LEGACY=offset-budget restores `offset + resultsWanted`.
    const detailsNeeded = legacy.has('offset-budget') ? run.offset + run.wanted : run.wanted;
    // `board` wants no detail pages, and sitemap entries carry nothing but a URL, so
    // the listing is the only source of card data — and the cheaper one (1 request
    // per 21 offers, against the sitemap plus 1 request per offer): D5, kept on
    // purpose, whoever asked for `board`.
    //
    // In `auto`, a detail budget that cannot cover every wanted offer (`detail-25`
    // with resultsWanted 30, or more than SOFTY_MAX_DETAIL_FETCHES) used to read list
    // pages too, so the listing returned the rest board-only. `resultsWanted` and
    // `descriptionDepth` are CALLER parameters, so under a caller lock (`stricter` /
    // `none`: the Softy default) that trigger no longer applies (round 2, A1, audit
    // G22): the sitemap path returns what the budget allows, with a `partial` note.
    // The listing stays the operator's to choose: an operator `auto` (env, sites /
    // hosts), a lifted lock (`callerOverrides: 'any'`), SOFTY_MAX_DETAIL_FETCHES=0
    // (detail pages off), or SOFTY_LEGACY=caller-listing (the pre-round-2 selection).
    const budgetShort = run.discovery === 'auto' && run.detailBudget < detailsNeeded;
    const keepSitemap =
      budgetShort &&
      run.callerLock.mode !== 'any' &&
      !run.operatorDiscovery &&
      run.config.maxDetailFetches > 0 &&
      !legacy.has('caller-listing');
    const useListing =
      !listPagesOff &&
      (run.discovery === 'listing' ||
        (run.depth === 'board' && !operatorSitemap) ||
        (budgetShort && !keepSitemap));
    run.budgetKeptOnSitemap = keepSitemap && !useListing && !listPagesOff;

    if (!useListing) {
      const stage = await this.discoverFromSitemap(run);
      if (stage.kind === 'entries') {
        await this.collectFromSitemap(run, stage.entries, posts, stage.listedAt);
        return;
      }
      if (stage.kind === 'stop' || run.stopped) return;
      if (run.discovery === 'sitemap') {
        this.logger.log(`Softy: no usable sitemap for ${run.tenant} (discovery=sitemap, no listing fallback)`);
        return;
      }
      if (listPagesOff) {
        this.logger.log(
          `Softy: no usable sitemap for ${run.tenant}, and list pages are disabled (${SOFTY_ENV.MAX_LIST_PAGES}=0)`,
        );
        return;
      }
      this.logger.log(`Softy: no usable sitemap for ${run.tenant}; falling back to the listing`);
    }

    await this.collectFromListing(run, posts);
  }

  // ── Sitemap stage (Spec 1715 §7.3) ──────────────────────────────────────────

  /**
   * The tenant's `/offers/{ID}` sitemap entries (one per offer id, newest `lastmod`
   * first), from the per-tenant cache or one sitemap walk — or `fallback` (the sitemap
   * held no offer / could not be parsed, or an error the fallback mode lets `auto`
   * fall back on) or `stop` (the scrape stopped; the reason is on the run).
   */
  private async discoverFromSitemap(run: SoftyRun): Promise<SitemapStage> {
    const dedupe = !run.config.legacy.has('duplicate-ids');
    const cacheKey = `${run.origin}|${dedupe ? 'by-id' : 'all'}`;
    const cached = this.cachedSitemap(run.config, cacheKey);
    if (cached) {
      this.logger.debug(`Softy: sitemap of ${run.tenant} served from the cache (${cached.entries.length} offer(s))`);
      return { kind: 'entries', entries: cached.entries, listedAt: cached.listedAt };
    }
    if (run.stopped || this.isAborted(run)) return { kind: 'stop' };

    const url = `${run.origin}${SOFTY_SITEMAP_PATH}`;
    let lastUrl = url;
    // When the ROOT sitemap answered (round 2, A3): what `jobUrlListedAt` carries.
    // The children of a sitemap index answer later, so it never overstates how
    // recently an offer was listed.
    let listedAt: string | undefined;
    // Pacing, identity and retries stay in HttpClient; the adapter only lets the plugin
    // see the body (to tell a bot wall from a soft-404, D1) and refuses to send
    // anything once the scrape has stopped.
    const adapter: SitemapHttp = {
      get: async <T = any>(target: string, requestConfig?: any) => {
        if (run.stopped || this.isAborted(run)) throw new SoftyStoppedError();
        lastUrl = target;
        run.requests++;
        const response = await run.client.get(target, requestConfig);
        if (listedAt === undefined) listedAt = new Date().toISOString();
        let text: string;
        try {
          const maxBytes = Number(requestConfig?.maxContentLength);
          text = decodeSitemapBody(response?.data, maxBytes > 0 ? maxBytes : SITEMAP_DEFAULT_MAX_BYTES);
        } catch (err) {
          throw new SoftySitemapDecodeError(target, err);
        }
        if (softySitemapBodyKind(text) === 'challenge') throw new SoftyChallengeError(target);
        return { ...response, data: text as unknown as T };
      },
    };

    let entries: SitemapEntry[];
    try {
      // Nested sitemaps: `stop-on-throttle` (fetchSitemap's default, Spec 1714 FR-13)
      // rethrows a 429 / 503 / crawl-policy refusal — a scrape stop; other failures
      // reach onNestedSitemapError. `skip` (SOFTY_SITEMAP_FALLBACK=any-error, or
      // SOFTY_LEGACY=nested-skip; round 2, F4) skips every nested failure (pre-1715).
      entries = await fetchSitemap(adapter, url, {
        sortByLastmod: true,
        filter: (loc) => softyOfferIdFromUrl(loc, run.host) !== null,
        onError: (nested, err) => this.onNestedSitemapError(run, nested, err),
        nestedErrors: this.skipsNestedErrors(run) ? 'skip' : 'stop-on-throttle',
      });
    } catch (err) {
      return lastUrl === url ? this.sitemapFailure(run, url, err) : this.nestedSitemapStop(run, lastUrl, err);
    }
    if (run.stopped) return { kind: 'stop' };

    // FR-10 (audit G25): one entry per offer id — the first in lastmod order is the
    // newest. SOFTY_LEGACY=duplicate-ids restores no dedupe.
    const offers = dedupe ? this.uniqueOffers(entries, run.host) : entries;
    if (offers.length === 0) {
      this.logger.log(`Softy sitemap of ${run.tenant} holds no offer (or could not be parsed)`);
      return { kind: 'fallback' };
    }
    const listed = listedAt ?? new Date().toISOString();
    this.cacheSitemap(run.config, cacheKey, offers, listed);
    return { kind: 'entries', entries: offers, listedAt: listed };
  }

  /**
   * Whether a nested-sitemap failure is skipped and the walk goes on (the pre-1715
   * behaviour): under `SOFTY_SITEMAP_FALLBACK=any-error` or `SOFTY_LEGACY=nested-skip`
   * (round 2, F4). Otherwise push-back, a refusal and a struggling server stop the
   * scrape (Spec 1715 FR-16; round 2, A5).
   */
  private skipsNestedErrors(run: SoftyRun): boolean {
    return run.config.sitemapFallback === 'any-error' || run.config.legacy.has('nested-skip');
  }

  /**
   * A failure of the ROOT sitemap, per `SOFTY_SITEMAP_FALLBACK` (Spec 1715 §7.3). In
   * explicit `sitemap` mode every "fallback" cell is a stop with the error as the
   * diagnostic (unchanged from Spec 1691).
   */
  private sitemapFailure(run: SoftyRun, url: string, err: unknown): SitemapStage {
    if (err instanceof SoftyStoppedError || run.stopped) return { kind: 'stop' };
    // Always a stop, in every mode (as before 1715): abort, 429, a crawl-policy refusal
    // other than robots.txt (cool-down, queue timeout, egress guard).
    if (this.isFatal(run, err)) {
      this.stopOnFatal(run, err, 'sitemap');
      return { kind: 'stop' };
    }

    const mode = run.config.sitemapFallback;
    const explicit = run.discovery === 'sitemap';
    const status = this.httpStatus(err);
    type Action = 'fallback' | 'empty' | 'blocked' | 'rate_limited' | 'unknown-tenant' | 'not-found' | 'error';
    let action: Action;
    if (err instanceof SoftyChallengeError) {
      // `any-error` = shipped: a challenge page was just a sitemap without offers.
      action = mode === 'any-error' ? 'empty' : 'blocked';
    } else if (err instanceof SoftySitemapDecodeError) {
      action = 'fallback'; // could not be parsed
    } else if (run.requests === 1 && this.isUnknownHost(err)) {
      action = mode === 'any-error' ? 'fallback' : 'unknown-tenant';
    } else if (this.isRobotsRefusal(err)) {
      action = mode === 'empty' ? 'blocked' : 'fallback';
    } else if (mode === 'any-error') {
      action = 'fallback';
    } else if (status === 404 || status === 410) {
      action = mode === 'missing' ? 'fallback' : 'not-found';
    } else if (status !== undefined && BLOCK_STATUSES.has(status)) {
      action = 'blocked';
    } else if (status === 503) {
      action = 'rate_limited';
    } else {
      action = 'error'; // other 4xx, 500/502/504, timeout, reset, other network errors
    }

    switch (action) {
      case 'empty':
        this.logger.log(`Softy sitemap of ${run.tenant} is not a sitemap (${(err as Error).message})`);
        return { kind: 'fallback' };
      case 'fallback':
        if (explicit) run.error = preferRefusalError(run.error, err);
        if (this.isMissing(err)) {
          this.logger.log(`Softy sitemap not available (HTTP ${status ?? 'n/a'}) for ${run.tenant}`);
        } else {
          this.logger.warn(`Softy sitemap fetch failed for ${run.tenant}: ${(err as Error)?.message ?? err}`);
        }
        return explicit ? { kind: 'stop' } : { kind: 'fallback' };
      case 'unknown-tenant':
        this.stopUnknownTenant(run, err);
        return { kind: 'stop' };
      case 'blocked':
      case 'rate_limited':
        this.stopScrape(run, err, action, 'sitemap');
        return { kind: 'stop' };
      case 'not-found':
        this.stopScrape(
          run,
          err,
          undefined,
          'sitemap',
          explicit
            ? undefined
            : new ScrapeDiagnostics(
                'bad_input',
                `Softy sitemap ${url} answered HTTP ${status}; not falling back to list pages ` +
                  `(${SOFTY_ENV.SITEMAP_FALLBACK}=missing allows it)`,
              ),
        );
        return { kind: 'stop' };
      default:
        this.stopScrape(run, err, undefined, 'sitemap');
        return { kind: 'stop' };
    }
  }

  /**
   * A nested sitemap's push-back, rethrown by `fetchSitemap` (429 / 503 / a crawl-policy
   * refusal; Spec 1714 FR-13): a scrape stop (Spec 1715 FR-16) — unless nested errors
   * are skipped (`skipsNestedErrors`), when `fetchSitemap` never rethrows them.
   */
  private nestedSitemapStop(run: SoftyRun, url: string, err: unknown): SitemapStage {
    if (err instanceof SoftyStoppedError || run.stopped) return { kind: 'stop' };
    if (this.isFatal(run, err)) {
      this.stopOnFatal(run, err, `nested sitemap ${url}`);
    } else if (this.httpStatus(err) === 503) {
      this.stopScrape(run, err, 'rate_limited', `nested sitemap ${url}`);
    } else if (this.isRobotsRefusal(err)) {
      this.stopScrape(run, err, 'blocked', `nested sitemap ${url}`);
    } else {
      this.stopScrape(run, err, undefined, `nested sitemap ${url}`);
    }
    return { kind: 'stop' };
  }

  /**
   * A nested sitemap that failed without `fetchSitemap` stopping the walk. The scrape
   * stops when it
   *
   * - refused us (401/403/407, a challenge page): `blocked` (Spec 1715 FR-6);
   * - found the server struggling (500/502/504, a timeout, a connection reset — the
   *   `isServerStruggling` classifier behind the crawl policy's server-error
   *   cool-down): the error's diagnostic (`fetch_error` / `timeout`), as on the root
   *   sitemap (round 2, A5 — ask D: back off when the server struggles).
   *
   * `run.stopped` makes the adapter refuse the rest of the walk. Anything else (a
   * 404/410, a size cap, bad gzip, a scope refusal) is skipped and the walk goes on.
   * Under `skipsNestedErrors` (`SOFTY_SITEMAP_FALLBACK=any-error`,
   * `SOFTY_LEGACY=nested-skip`) every nested failure is skipped, as before Spec 1715.
   */
  private onNestedSitemapError(run: SoftyRun, nested: string, err: any): void {
    if (err instanceof SoftyStoppedError) return;
    if (!this.skipsNestedErrors(run)) {
      const status = this.httpStatus(err);
      const refused = err instanceof SoftyChallengeError || (status !== undefined && BLOCK_STATUSES.has(status));
      if (refused) {
        this.stopScrape(run, err, 'blocked', `nested sitemap ${nested}`);
        return;
      }
      if (isServerStruggling(status, err)) {
        this.stopScrape(run, err, undefined, `nested sitemap ${nested}`);
        return;
      }
    }
    this.logger.debug(`Softy nested sitemap ${nested} skipped: ${err?.message ?? err}`);
  }

  /** One entry per offer id, the first one met (entries come newest `lastmod` first). */
  private uniqueOffers(entries: SitemapEntry[], host: string): SitemapEntry[] {
    const seen = new Set<string>();
    const out: SitemapEntry[] = [];
    for (const entry of entries) {
      const id = softyOfferIdFromUrl(entry.loc, host);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
    return out;
  }

  /**
   * Sitemap discovery: detail pages in `lastmod` order until `wanted` roles are built.
   * An offer whose detail page the budget (or the attempt cap) no longer covers — and
   * is not cached — yields no post; when that shortens the result, a `partial`
   * diagnostic says so. Every post carries `jobUrlListedAt = listedAt` (round 2, A3):
   * the offer is listed in a sitemap the network answered at that instant.
   */
  private async collectFromSitemap(
    run: SoftyRun,
    entries: SitemapEntry[],
    posts: JobPostDto[],
    listedAt: string,
  ): Promise<void> {
    let produced = 0;
    let overBudget = 0;
    let overCap = 0;
    for (let i = run.offset; i < entries.length && produced < run.wanted; i++) {
      if (this.isAborted(run)) break;
      const entry = entries[i];
      const id = softyOfferIdFromUrl(entry.loc, run.host);
      if (!id) continue;
      const url = softyOfferUrlFrom(run.origin, id);
      const key = `${url}|${entry.lastmodRaw ?? ''}`;
      if (!run.stopDetails && !run.cache?.get(key)) {
        if (run.detailFetches >= run.detailBudget) {
          overBudget++;
          continue;
        }
        if (run.detailFetches >= run.detailAttemptCap) {
          overCap++;
          continue;
        }
      }
      const { detail, fetchedAt } = await this.getDetail(run, url, key, 'sitemap');
      if (!detail) continue;
      try {
        const post = this.buildPost(
          { id, url, lastmod: entry.lastmod ?? null },
          run,
          detail,
          { url, at: fetchedAt },
          listedAt,
        );
        if (post) {
          posts.push(post);
          produced++;
        }
      } catch (err: any) {
        this.logger.warn(`Error processing Softy role ${id}: ${err?.message ?? err}`);
      }
    }
    if (produced >= run.wanted || run.note !== undefined) return;
    let detail: string | undefined;
    if (overBudget > 0 && run.depth === 'board') {
      detail =
        `descriptionDepth 'board' fetches no detail page and discovery 'sitemap' reads no list page: ` +
        `${overBudget} sitemap offer(s) not returned (only cached offers are); use descriptionDepth ` +
        `detail-25 / detail-all${run.config.maxListPages === 0 ? '' : ', or SOFTY_LEGACY=board-over-sitemap'}`;
    } else if (overBudget > 0 && run.budgetKeptOnSitemap) {
      detail =
        `detail-page budget (${run.detailBudget}) exhausted: ${overBudget} sitemap offer(s) not returned. ` +
        `Caller overrides are '${run.callerLock.mode}' (set by ${run.callerLock.source}), so no list page is read ` +
        'for a larger resultsWanted (Softy asked for sitemap discovery); ask for fewer results or a larger ' +
        `descriptionDepth (up to ${SOFTY_ENV.MAX_DETAIL_FETCHES}=${run.config.maxDetailFetches}), or the operator ` +
        `sets discovery 'auto' / 'listing' (${CRAWL_ENV.DISCOVERY}, sites.softy) or ${SOFTY_ENV.LEGACY}=caller-listing`;
    } else if (overBudget > 0) {
      detail =
        `detail-page budget (${run.detailBudget}) exhausted: ${overBudget} sitemap offer(s) not returned; ` +
        'use crawl.discovery=listing (board-only beyond the budget) or a larger descriptionDepth / SOFTY_MAX_DETAIL_FETCHES';
    } else if (overCap > 0) {
      detail =
        `detail-page attempts capped at ${run.detailAttemptCap} (resultsWanted ${run.wanted} + ` +
        `${SOFTY_ENV.DETAIL_ATTEMPT_SLACK} ${run.config.detailAttemptSlack}) after offers that are gone: ` +
        `${overCap} sitemap offer(s) not tried`;
    }
    if (detail) {
      this.logger.warn(`Softy ${run.tenant}: ${detail}`);
      run.note = new ScrapeDiagnostics('partial', detail);
    }
  }

  // ── Listing stage (Spec 1715 §7.4) ──────────────────────────────────────────

  /**
   * Listing discovery: `/offers?page=1..N`, then detail pages per `descriptionDepth`.
   * Tenants still on the legacy markup are read from the legacy index instead.
   */
  private async collectFromListing(run: SoftyRun, posts: JobPostDto[]): Promise<void> {
    const needed = run.offset + run.wanted;
    const cards: SoftyCardJob[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= run.config.maxListPages; page++) {
      if (this.isAborted(run) || run.stopped) break;
      const outcome = await this.fetchPage(run, softyListingPageUrlFrom(run.origin, page), 'listing');
      if (outcome.kind === 'stop') break;
      if (outcome.kind === 'failed') {
        run.error = preferRefusalError(run.error, outcome.error);
        // A struggling server gets no detail requests either: the cards read so far are
        // returned board-only. SOFTY_LEGACY=listing-failure-details restores the
        // pre-1715 behaviour (details still fetched).
        if (!run.config.legacy.has('listing-failure-details')) run.stopDetails = true;
        break;
      }
      if (outcome.kind === 'missing') {
        if (page === 1) await this.collectLegacyIndex(run, cards, seen, needed);
        break;
      }

      const parsed = parseSoftyListingPage(outcome.html, run.tenant, run.origin);
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

  /**
   * Legacy fallback: the single-page index with `/offre/{ID}-{slug}` anchors, read at
   * `/offers` — the target of the `/offres` 301, so no unpaced redirect hop (FR-14,
   * audit G6). SOFTY_LEGACY=offres requests `/offres` (pre-1715).
   */
  private async collectLegacyIndex(
    run: SoftyRun,
    cards: SoftyCardJob[],
    seen: Set<string>,
    needed: number,
  ): Promise<void> {
    const path = run.config.legacy.has('offres') ? SOFTY_OFFERS_PATH : SOFTY_LEGACY_INDEX_PATH;
    const outcome = await this.fetchPage(run, `${run.origin}${path}`, 'legacy index');
    if (outcome.kind === 'failed') {
      run.error = preferRefusalError(run.error, outcome.error);
      return;
    }
    if (outcome.kind !== 'ok') return;
    this.addLegacyCards(run, outcome.html, cards, seen, needed);
  }

  private addLegacyCards(
    run: SoftyRun,
    html: string,
    cards: SoftyCardJob[],
    seen: Set<string>,
    needed: number,
  ): void {
    for (const card of this.parseIndex(html, run.origin, run.config.legacy.has('legacy-detail-url'))) {
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
      const result: DetailResult =
        url && run.depth !== 'board' ? await this.getDetail(run, url, url, 'listing') : { detail: null };
      try {
        const post = this.buildPost(card, run, result.detail, url ? { url, at: result.fetchedAt } : undefined);
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
   * and the attempt cap last and the scrape has not stopped. `fetchedAt` is set only
   * for a page this call fetched from the network and parsed. Never throws.
   */
  private async getDetail(
    run: SoftyRun,
    url: string,
    key: string,
    source: 'sitemap' | 'listing',
  ): Promise<DetailResult> {
    const cached = run.cache?.get(key);
    if (cached) return { detail: cached };
    if (
      run.stopped ||
      run.stopDetails ||
      run.detailFetches >= run.detailBudget ||
      run.detailFetches >= run.detailAttemptCap ||
      this.isAborted(run)
    ) {
      return { detail: null };
    }

    run.detailFetches++;
    const outcome = await this.fetchPage(run, url, 'detail');
    if (outcome.kind === 'ok') {
      run.consecutiveDetailFailures = 0;
      const detail = parseSoftyDetailPage(outcome.html);
      if (!detail) return { detail: null };
      // FR-13: sitemap entries (url|lastmod) never go stale; listing entries (url) keep a TTL.
      run.cache?.set(
        key,
        detail,
        source === 'sitemap' ? run.config.detailCacheTtlMs : run.config.listingDetailCacheTtlMs,
      );
      return { detail, fetchedAt: outcome.fetchedAt };
    }
    if (outcome.kind === 'missing') {
      run.consecutiveDetailFailures = 0;
      return { detail: null };
    }
    if (outcome.kind === 'stop') return { detail: null };

    run.error = preferRefusalError(run.error, outcome.error);
    run.consecutiveDetailFailures++;
    const max = run.config.maxConsecutiveDetailFailures;
    if (max > 0 && run.consecutiveDetailFailures >= max) {
      run.stopDetails = true;
      this.logger.warn(
        `Softy: ${run.consecutiveDetailFailures} detail page(s) failed in a row for ${run.tenant}; ` +
          `not fetching more this scrape (${SOFTY_ENV.MAX_CONSECUTIVE_DETAIL_FAILURES}=${max})`,
      );
    }
    return { detail: null };
  }

  private getDetailCache(config: SoftyConfig): BoundedTtlCache<SoftyDetail> | null {
    if (config.detailCacheMax <= 0) return null;
    const shape = `${config.detailCacheMax}:${config.detailCacheTtlMs}:${config.listingDetailCacheTtlMs}`;
    if (!this.detailCache || this.detailCacheShape !== shape) {
      this.detailCache = new BoundedTtlCache<SoftyDetail>(config.detailCacheMax, config.detailCacheTtlMs, () =>
        Date.now(),
      );
      this.detailCacheShape = shape;
    }
    return this.detailCache;
  }

  // ── Caches (Spec 1715 FR-5, FR-12) ──────────────────────────────────────────

  /** A tenant's cached sitemap (offer entries + when the network answered it), younger than `SOFTY_SITEMAP_CACHE_TTL_MS`. */
  private cachedSitemap(config: SoftyConfig, key: string): CachedSitemap | undefined {
    if (config.sitemapCacheTtlMs <= 0 || !this.sitemapCache) return undefined;
    const hit = this.sitemapCache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= config.sitemapCacheTtlMs) {
      this.sitemapCache.delete(key);
      return undefined;
    }
    return hit;
  }

  private cacheSitemap(config: SoftyConfig, key: string, entries: SitemapEntry[], listedAt: string): void {
    if (config.sitemapCacheTtlMs <= 0) return;
    if (!this.sitemapCache) {
      this.sitemapCache = new BoundedTtlCache<CachedSitemap>(SOFTY_SITEMAP_CACHE_MAX, 0, () => Date.now());
    }
    this.sitemapCache.set(key, { entries, at: Date.now(), listedAt }, config.sitemapCacheTtlMs);
  }

  /** A tenant whose host did not resolve within `SOFTY_UNKNOWN_TENANT_TTL_MS` (not in `any-error` mode). */
  private isKnownUnknownTenant(config: SoftyConfig, origin: string): boolean {
    if (config.sitemapFallback === 'any-error' || config.unknownTenantTtlMs <= 0 || !this.unknownTenants) return false;
    const seenAt = this.unknownTenants.get(origin);
    return seenAt !== undefined && Date.now() - seenAt < config.unknownTenantTtlMs;
  }

  /** Stop the scrape: the tenant's host does not resolve (FR-5); remember it for the TTL. */
  private stopUnknownTenant(run: SoftyRun, err: unknown): void {
    if (run.config.unknownTenantTtlMs > 0) {
      if (!this.unknownTenants) {
        this.unknownTenants = new BoundedTtlCache<number>(
          SOFTY_UNKNOWN_TENANT_CACHE_MAX,
          SOFTY_UNKNOWN_TENANT_TTL_MAX_MS,
          () => Date.now(),
        );
      }
      this.unknownTenants.set(run.origin, Date.now());
    }
    this.stopScrape(run, err, undefined, 'first request', this.unknownTenantDiagnostics(run.tenant, run.host, run.config));
  }

  private unknownTenantDiagnostics(tenant: string, host: string, config: SoftyConfig): ScrapeDiagnostics {
    const ttl = config.unknownTenantTtlMs;
    const memo =
      ttl > 0
        ? `not asked again for ${formatDuration(ttl)}; ${SOFTY_ENV.UNKNOWN_TENANT_TTL_MS}`
        : `negative cache off: ${SOFTY_ENV.UNKNOWN_TENANT_TTL_MS}=0`;
    return new ScrapeDiagnostics('bad_input', `unknown Softy tenant ${JSON.stringify(tenant)}: ${host} does not resolve (${memo})`);
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  /**
   * GET a page as text, classified per Spec 1715 §7.4:
   *
   * - `ok`: a 2xx page (a 2xx bot wall is a `blocked` stop instead);
   * - `stop`: the scrape stopped — push-back (401/403/407 → `blocked`, 429 / 503 →
   *   `rate_limited`), an unknown tenant on the first request, a crawl-policy refusal
   *   (cool-down, queue timeout, egress guard) or an abort — or it had already;
   * - `missing`: another 4xx, a robots.txt refusal, a non-text body;
   * - `failed`: a 5xx / timeout / network error (the caller decides).
   *
   * `SOFTY_LEGACY=block-as-missing` / `503-as-failure` restore the pre-1715 `missing` /
   * `failed` for blocks and 503s.
   */
  private async fetchPage(run: SoftyRun, url: string, stage: 'listing' | 'legacy index' | 'detail'): Promise<FetchOutcome> {
    if (run.stopped || this.isAborted(run)) return { kind: 'stop' };
    run.requests++;
    const first = run.requests === 1 && stage !== 'detail';
    const legacy = run.config.legacy;
    try {
      const response = await run.client.get<string>(url, { responseType: 'text' });
      if (typeof response?.data === 'string') {
        if (!legacy.has('block-as-missing') && looksLikeSoftyChallenge(response.data)) {
          this.stopScrape(run, new SoftyChallengeError(url), 'blocked', stage);
          return { kind: 'stop' };
        }
        return { kind: 'ok', html: response.data, fetchedAt: new Date().toISOString() };
      }
      this.logger.warn(`Softy: non-text body for ${url}; ignoring it`);
      return { kind: 'missing', status: response?.status };
    } catch (err: any) {
      if (this.isFatal(run, err)) {
        this.stopOnFatal(run, err, stage);
        return { kind: 'stop' };
      }
      const status = this.httpStatus(err);
      if (first && this.isUnknownHost(err) && run.config.sitemapFallback !== 'any-error') {
        this.stopUnknownTenant(run, err);
        return { kind: 'stop' };
      }
      if (this.isRobotsRefusal(err)) {
        run.error = preferRefusalError(run.error, err);
        this.logger.warn(`Softy: robots.txt disallows ${url}`);
        return { kind: 'missing' };
      }
      if (status === 503 && !legacy.has('503-as-failure')) {
        this.stopScrape(run, err, 'rate_limited', stage);
        return { kind: 'stop' };
      }
      if (status !== undefined && BLOCK_STATUSES.has(status) && !legacy.has('block-as-missing')) {
        this.stopScrape(run, err, 'blocked', stage);
        return { kind: 'stop' };
      }
      if (this.isMissing(err)) {
        this.logger.warn(`Softy page not found (HTTP ${status ?? err?.code ?? 'n/a'}) for ${run.tenant}: ${url}`);
        return { kind: 'missing', status };
      }
      // 5xx / timeout / network — the caller decides (a detail failure, a listing stop).
      this.logger.warn(`Softy fetch failed for ${run.tenant} (${url}): ${err?.message ?? err}`);
      return { kind: 'failed', error: err };
    }
  }

  private httpStatus(err: any): number | undefined {
    const status = err?.response?.status ?? err?.status;
    return typeof status === 'number' ? status : undefined;
  }

  /** A host that does not resolve (`ENOTFOUND` on the error or its `cause` chain; not `EAI_AGAIN`). */
  private isUnknownHost(err: any): boolean {
    if (this.httpStatus(err) !== undefined) return false;
    let current = err;
    for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
      if (current.code === 'ENOTFOUND') return true;
      current = current.cause;
    }
    return false;
  }

  /** 4xx other than 429, or a host that does not resolve. */
  private isMissing(err: any): boolean {
    const status = this.httpStatus(err);
    if (status !== undefined) return status >= 400 && status < 500 && status !== 429;
    return this.isUnknownHost(err);
  }

  private isRobotsRefusal(err: any): boolean {
    return isCrawlPolicyError(err) && err.code === 'ERR_CRAWL_ROBOTS_DISALLOWED';
  }

  /** Errors after which this scrape sends nothing more to Softy, whatever the mode. */
  private isFatal(run: SoftyRun, err: any): boolean {
    if (this.isAborted(run)) return true;
    if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError' || err?.name === 'CanceledError') return true;
    if (this.httpStatus(err) === 429) return true;
    return isCrawlPolicyError(err) && !this.isRobotsRefusal(err);
  }

  /** Stop on a fatal error: a 429 or a crawl-policy hold-back is `rate_limited`. */
  private stopOnFatal(run: SoftyRun, err: any, stage: string): void {
    let reason: SoftyStopReason | undefined;
    if (this.httpStatus(err) === 429) {
      reason = 'rate_limited';
    } else if (isCrawlPolicyError(err)) {
      const classified = classifyScrapeError(err).reason;
      if (classified === 'rate_limited' || classified === 'blocked') reason = classified;
    }
    this.stopScrape(run, err, reason, stage);
  }

  /**
   * Stop the whole scrape: no further request of any kind (Spec 1715 §7.3 / §7.4).
   * `run.error` keeps the most telling error (`preferRefusalError`, FR-8); the stop's
   * diagnostic — `diagnostics`, else `reason` with the error's message — wins over it.
   */
  private stopScrape(
    run: SoftyRun,
    err: unknown,
    reason: SoftyStopReason | undefined,
    stage: string,
    diagnostics?: ScrapeDiagnostics,
  ): void {
    run.stopped = true;
    run.stopDetails = true;
    if (err !== undefined) run.error = preferRefusalError(run.error, err);
    if (!run.stopDiagnostics) {
      if (diagnostics) run.stopDiagnostics = diagnostics;
      else if (reason) run.stopDiagnostics = new ScrapeDiagnostics(reason, classifyScrapeError(err).detail ?? reason);
    }
    if (!this.isAborted(run)) {
      const message = (err as Error)?.message ?? String(err);
      this.logger.warn(`Softy stopped at ${stage} for ${run.tenant}${reason ? ` (${reason})` : ''}: ${message}`);
    }
  }

  private isAborted(run: SoftyRun): boolean {
    return run.signal?.aborted === true;
  }

  // ── Mapping ─────────────────────────────────────────────────────────────────

  /**
   * A post from a card and its detail fields. `fetched` names the URL whose detail
   * page this scrape fetched from the network and when; `jobUrlFetchedAt` is set only
   * when that URL is the post's `jobUrl` (Spec 1715 FR-15) — never for a cache hit.
   * `listedAt` (sitemap path only): when the sitemap listing this offer was fetched
   * from the network — `jobUrlListedAt` (round 2, A3).
   */
  private buildPost(
    card: SoftyCardJob,
    run: SoftyRun,
    detail: SoftyDetail | null,
    fetched?: { url: string; at?: string },
    listedAt?: string,
  ): JobPostDto | null {
    const job = this.normaliseJob(card, run.origin, run.tenant, detail, run.config);
    const fetchedAt = detail && fetched?.at && fetched.url === job.url ? fetched.at : undefined;
    return this.processJob(job, run.tenant, run.format, fetchedAt, listedAt);
  }

  /**
   * Parse the server-rendered index HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical detail links
   * (`/offre/{ID}-{title-slug}`) and read the labelled card text immediately around
   * each link (location, contract type, "Mise en ligne le …"). The card's URL is the
   * target of that link's 301, `/offers/{ID}` (round 2, A0: every detail GET is one
   * paced request); `legacyDetailUrl` (`SOFTY_LEGACY=legacy-detail-url`) keeps the
   * `/offre/{ID}-{slug}` link itself (pre-1715).
   */
  private parseIndex(html: string, origin: string, legacyDetailUrl = false): SoftyCardJob[] {
    const out: SoftyCardJob[] = [];
    const byId = new Map<string, SoftyCardJob>();

    SOFTY_OFFER_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SOFTY_OFFER_LINK_REGEX.exec(html)) !== null) {
      const [, id, slug] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const cleanSlug = this.deslugTitleSlug(slug);
      const url = legacyDetailUrl
        ? `${origin}${SOFTY_OFFER_PATH}${jobId}-${this.cleanText(slug) ?? ''}`
        : softyOfferUrlFrom(origin, jobId);

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
    origin: string,
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
      url: this.cleanText(card.url) ?? this.buildJobUrl(origin, card, config?.legacy.has('legacy-detail-url') ?? false),
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

  /**
   * Map a normalised SoftyJob → JobPostDto. `jobUrlFetchedAt` (Spec 1715 FR-15): when
   * this scrape fetched the post's `jobUrl` from the network (2xx, parsed) and when.
   * `jobUrlListedAt` (round 2, A3): when the sitemap that listed the offer was fetched
   * from the network — evidence the offer is live that `?liveness=true` trusts within
   * `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`, also on a cache hit.
   */
  private processJob(
    job: SoftyJob,
    tenant: string,
    format?: DescriptionFormat,
    jobUrlFetchedAt?: string,
    jobUrlListedAt?: string,
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
    const location = this.extractLocation(job);

    return new JobPostDto({
      id: `softy-${atsId}`,
      title,
      companyName,
      jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
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
      ...(jobUrlFetchedAt ? { jobUrlFetchedAt } : {}),
      ...(jobUrlListedAt ? { jobUrlListedAt } : {}),
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
   * Build the public detail / apply URL for a role from its parts: the canonical
   * `/offers/{ID}` — also for legacy cards, whose `/offre/{ID}-{slug}` link
   * 301-redirects there (round 2, A0). `legacyDetailUrl`
   * (`SOFTY_LEGACY=legacy-detail-url`) restores the `/offre/{ID}-{slug}` form for
   * legacy cards (or any card with a slug), as before.
   */
  private buildJobUrl(origin: string, card: SoftyCardJob, legacyDetailUrl = false): string {
    const id = this.cleanText(card.id) ?? '';
    const slug = this.cleanText(card.slug);
    if (!legacyDetailUrl || (!card.legacy && !slug)) return softyOfferUrlFrom(origin, id);
    return `${origin}${SOFTY_OFFER_PATH}${id}-${slug ?? ''}`;
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
   * country through the shared `parseLocationText` (Spec 5125). Softy tenants are
   * French, so a bare city line yields just the city.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parsed = parseLocationText(text).location;
    return {
      city: parsed?.city ?? null,
      state: parsed?.state ?? null,
      country: parsed?.country ?? null,
    };
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

/** The hostname (no port) of a tenant origin. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

/** `3600000` → `1 h`, `600000` → `10 min`, `45000` → `45 s`, else `N ms`. */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}
