/**
 * Crawl policy — the single, configurable description of *how* Ever Jobs talks to
 * the sites it reads (Spec 1690).
 *
 * Every outbound request made through `HttpClient` (and every page opened through
 * `BrowserPool`) is governed by a resolved `CrawlPolicy`. The policy is assembled
 * from layers, lowest precedence first:
 *
 *   1. preset          — `polite` (built-in default), `legacy` or `strict`
 *                        (`EVER_JOBS_CRAWL_PRESET`)
 *   2. env-global      — `EVER_JOBS_CRAWL_*` variables
 *   3. builtin-host    — `BUILTIN_HOST_POLICIES` for known bulk APIs
 *   4. plugin          — `@SourcePlugin({ crawl })` defaults + options a plugin
 *                        passes to `createHttpClient` / `setHeaders`
 *   5. operator-site   — `EVER_JOBS_CRAWL_POLICIES` / `EVER_JOBS_CRAWL_POLICY_FILE`
 *                        `sites[<site>]`, then `hosts[<pattern>]`
 *   6. caller          — the search request's `crawl` object (and the legacy flat
 *                        DTO fields), subject to `EVER_JOBS_CRAWL_CALLER_OVERRIDES`
 *
 * Nothing that existed before Spec 1690 was removed: the pre-1690 behaviour is
 * the `legacy` preset, and each individual knob can be set on its own at any
 * layer.
 */

import type { ScrapeProxyPin } from './proxy-selector';

/**
 * Which User-Agent goes on the wire.
 *
 * - `identify` (default): the configured Ever Jobs UA on every request, EXCEPT for
 *   plugins whose manifest declares `userAgentMode: 'plugin'` with a reason (an
 *   API that requires its own UA, e.g. USAJobs' registered e-mail).
 * - `strict`: the configured UA on every request, no exceptions.
 * - `plugin`: whatever UA the plugin declares (per-request header, `setHeaders`,
 *   or the `userAgent` client option) wins; the configured UA is only a fallback.
 */
export type UserAgentMode = 'identify' | 'strict' | 'plugin';

/**
 * How a request picks a proxy from the proxy list.
 *
 * - `per-request`: round-robin on every request (the pre-1690 behaviour).
 * - `per-scrape`: one proxy for the whole scrape — shared by every `HttpClient`
 *   the scrape uses (`ScrapeContext.proxyPin`); outside any scrape context, one
 *   per `HttpClient`.
 * - `per-host` (default): the same proxy for the same rate-limit bucket, process
 *   wide — a site always sees one stable origin.
 * - `off`: never use a proxy, even when a list is supplied.
 */
export type ProxyRotation = 'per-request' | 'per-scrape' | 'per-host' | 'off';

/**
 * Granularity of the rate-limit bucket a request is counted against.
 *
 * - `host` (default): the exact hostname, e.g. `acme.softy.pro`.
 * - `domain`: the registrable domain, e.g. `softy.pro` — every tenant of a
 *   multi-tenant platform shares one budget.
 * - `site`: the plugin's `Site`, whatever hosts it touches.
 */
export type RateLimitScope = 'host' | 'domain' | 'site';

/** robots.txt handling. `off` (default) never fetches robots.txt. */
export type RobotsTxtMode = 'off' | 'crawl-delay' | 'respect';

export type RetryBackoff = 'exponential' | 'linear' | 'constant';

/** What to do when a server's `Retry-After` exceeds `maxRetryAfterMs`. */
export type RetryAfterOverMax = 'give-up' | 'cap';

/** How a multi-strategy plugin discovers postings. */
export type DiscoveryMode = 'auto' | 'sitemap' | 'listing';

/** Which layers a search caller may override. */
export type CallerOverridePolicy = 'any' | 'stricter' | 'none';

export type CrawlPreset = 'polite' | 'legacy' | 'strict';

export interface CrawlPolicy {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** The configured UA string (already expanded from `default`/`browser`). */
  userAgent: string;
  userAgentMode: UserAgentMode;
  /** Optional `From:` header (RFC 9110 §10.1.2) — an operator contact address. */
  from?: string;
  /** Drop `sec-ch-ua*` client hints whenever the configured UA is sent. */
  stripClientHints: boolean;

  // ── Proxies ───────────────────────────────────────────────────────────────
  proxyRotation: ProxyRotation;

  // ── Pacing (process-wide, per bucket) ─────────────────────────────────────
  rateLimitScope: RateLimitScope;
  /** Max requests in flight per bucket. 0 = unlimited. */
  maxConcurrentPerHost: number;
  /** Minimum gap between request *starts* in a bucket, ms. 0 = none. */
  minIntervalMs: number;
  /** Random extra 0..jitterMs added to each gap, ms. */
  jitterMs: number;
  /** Longest a request may wait for its slot before failing fast, ms. 0 = no limit. */
  maxQueueWaitMs: number;
  /** Slow a bucket down on 429/503 and recover gradually on success. */
  adaptiveThrottle: boolean;

  // ── Retries ───────────────────────────────────────────────────────────────
  retries: number;
  retryStatuses: number[];
  retryBackoff: RetryBackoff;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** Full jitter on the computed backoff. */
  retryJitter: boolean;
  /** Also retry connection resets / timeouts (no HTTP status). */
  retryOnNetworkError: boolean;
  respectRetryAfter: boolean;
  /** A `Retry-After` longer than this triggers `retryAfterOverMax`. */
  maxRetryAfterMs: number;
  retryAfterOverMax: RetryAfterOverMax;
  /**
   * Back-off floor for throttling answers (429/503), ms. Retry number n + 1 of a
   * 429/503 waits at least `throttleRetryDelayMs × 2^n`, capped at
   * `max(retryMaxDelayMs, throttleRetryDelayMs)` — never less than the normal
   * backoff, never earlier than a `Retry-After` within `maxRetryAfterMs`. The same
   * floor is the minimum whole-bucket cool-down after any 429/503 (retried or
   * not). 0 = no floor (the pre-1690 behaviour).
   */
  throttleRetryDelayMs: number;

  // ── Other ─────────────────────────────────────────────────────────────────
  robotsTxt: RobotsTxtMode;
  /** Refuse loopback / private / link-local / CGNAT / cluster destinations. */
  blockPrivateNetworks: boolean;
  /** Discovery strategy for plugins that support more than one. */
  discovery: DiscoveryMode;
}

/** A partial policy — what every layer contributes. */
export type CrawlPolicyOverride = Partial<CrawlPolicy>;

/** What a plugin may declare in `@SourcePlugin({ crawl })`. */
export interface PluginCrawlPolicy extends CrawlPolicyOverride {
  /**
   * Required when the plugin asks for `userAgentMode: 'plugin'`: why this source
   * cannot be read with the Ever Jobs UA (surfaced in docs and the policy API).
   */
  userAgentReason?: string;
}

/** Operator per-site / per-host policy file (`EVER_JOBS_CRAWL_POLICIES`). */
export interface CrawlPolicyFile {
  /** Keyed by `Site` value, e.g. `"softy"`. */
  sites?: Record<string, CrawlPolicyOverride>;
  /** Keyed by host pattern: exact host, or `*.suffix` for any subdomain. */
  hosts?: Record<string, CrawlPolicyOverride>;
}

export type CrawlPolicyLayer =
  | 'preset'
  | 'env-global'
  | 'builtin-host'
  | 'plugin'
  | 'operator-site'
  | 'operator-host'
  | 'caller';

/** A fully resolved policy plus where each field's value came from. */
export interface ResolvedCrawlPolicy extends CrawlPolicy {
  provenance: Partial<Record<keyof CrawlPolicy, CrawlPolicyLayer>>;
}

/** Parsed environment (see `readCrawlPolicyEnv`). */
export interface CrawlPolicyEnvConfig {
  preset: CrawlPreset;
  global: CrawlPolicyOverride;
  policies: CrawlPolicyFile;
  callerOverrides: CallerOverridePolicy;
  /** `EVER_JOBS_CRAWL_PROXIES`, falling back to `DEFAULT_PROXIES`. */
  proxies: string[];
  /** Abort a scrape's outstanding requests when the search deadline passes. */
  abortOnDeadline: boolean;
  /** Non-fatal problems found while parsing (bad JSON, unknown enum value…). */
  warnings: string[];
}

/**
 * Per-scrape context carried through AsyncLocalStorage from `JobsService` into
 * every `HttpClient`/`BrowserPool` call the plugin makes, without touching any of
 * the ~1,150 plugin call sites.
 */
export interface ScrapeContext {
  /** The `Site` being scraped. */
  site?: string;
  /** The plugin's `@SourcePlugin({ crawl })` defaults. */
  plugin?: PluginCrawlPolicy;
  /** What the search caller asked for (already filtered by caller-override rules). */
  caller?: CrawlPolicyOverride;
  /** Aborted when the search deadline passes (if `abortOnDeadline`). */
  signal?: AbortSignal;
  /** Proxies supplied by the caller for this search. */
  proxies?: string[];
  /**
   * The scrape's `per-scrape` proxy pin, shared by every `HttpClient` of the
   * scrape. `runWithScrapeContext` creates one for each new scrape (a nested
   * context inherits its parent's, like every field it leaves out).
   */
  proxyPin?: ScrapeProxyPin;
}

/** Input to `resolveCrawlPolicy`. */
export interface CrawlPolicyResolveInput {
  site?: string;
  /** Target hostname — selects builtin-host and operator-host layers. */
  host?: string;
  plugin?: PluginCrawlPolicy;
  /** Options a plugin passed to `createHttpClient` (treated as the plugin layer). */
  explicit?: CrawlPolicyOverride;
  caller?: CrawlPolicyOverride;
}

/** Options for `HostLimiter.acquire`. */
export interface HostLimiterAcquireOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  jitterMs: number;
  /** 0 = wait as long as it takes (until `signal` aborts). */
  maxWaitMs: number;
  adaptive: boolean;
  signal?: AbortSignal;
}

export type HostOutcome = 'ok' | 'throttled' | 'error';

export interface HostBucketSnapshot {
  key: string;
  active: number;
  queued: number;
  /** Current adaptive multiplier (1 = no slowdown). */
  slowdown: number;
  /** Epoch ms until which the bucket is cooling down after a 429/503, if any. */
  coolingDownUntil?: number;
}

/** Result of a robots.txt check. */
export interface RobotsDecision {
  allowed: boolean;
  /** `Crawl-delay` for our UA token (or `*`), in ms, if the file sets one. */
  crawlDelayMs?: number;
  /** `Sitemap:` lines, for plugins that want them. */
  sitemaps: string[];
}

/** One `<url>` of a sitemap. */
export interface SitemapEntry {
  loc: string;
  /** Raw `<lastmod>` text. */
  lastmodRaw?: string;
  /** Parsed `<lastmod>` (accepts ISO 8601 and `YYYY-MM-DD HH:MM:SS`), if valid. */
  lastmod?: Date;
}
