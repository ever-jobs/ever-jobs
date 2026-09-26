import { Logger } from '@nestjs/common';
import type {
  Browser,
  BrowserContext,
  Page,
  LaunchOptions,
  BrowserContextOptions,
  Response as PlaywrightResponse,
} from 'playwright';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { EVER_JOBS_DEFAULT_USER_AGENT } from '../http/crawl/defaults';
import { assertPublicHostname, assertPublicProxy, assertPublicResolution } from '../http/crawl/egress-guard';
import {
  crawlBrowserNavigationEnabled,
  crawlPluginManifestsEnabled,
  expandUserAgent,
  readCrawlPolicyEnv,
} from '../http/crawl/env';
import { EgressBlockedError, RobotsDisallowedError } from '../http/crawl/errors';
import { abortReasonOf, bucketKeyFor, getHostLimiter } from '../http/crawl/host-limiter';
import { sanitizeHeaderValue } from '../http/crawl/policy-schema';
import { getRobotsTxtCache } from '../http/crawl/robots';
import { getEffectiveCrawlPolicy, getScrapeContext } from '../http/crawl/scrape-context';
import type { CrawlPolicy, CrawlPolicyOverride, ResolvedCrawlPolicy } from '../http/crawl/types';
import { HttpClient, crawlAcquireOptions, recordAnswerOutcome } from '../http/http-client';
import { describeUrlForLog } from '../utils/url-guard';
import { STEALTH_INIT_SCRIPT, USER_AGENT_POOL, VIEWPORT_POOL } from './stealth-scripts';

/**
 * The UA a non-stealth page got before Spec 1690 (the first `USER_AGENT_POOL`
 * entry, identical to `LEGACY_BROWSER_USER_AGENT`). Now used only when the crawl
 * policy lets the plugin choose its UA and the plugin declared none.
 */
export const BROWSER_POOL_DEFAULT_USER_AGENT = USER_AGENT_POOL[0];

/** Where a browser context's User-Agent came from (Spec 1690 §4.2). */
export type BrowserUserAgentSource =
  /** The crawl policy's configured UA (`identify` / `strict`). */
  | 'configured'
  /** The caller's `BrowserPageOptions.userAgent` (policy mode `plugin`). */
  | 'declared'
  /** `USER_AGENT_POOL` — random under stealth, else its first entry (pre-1690). */
  | 'pool';

/** The User-Agent chosen for a new browser context. */
export interface BrowserUserAgentChoice {
  userAgent: string;
  source: BrowserUserAgentSource;
  /**
   * True when the UA is a random `USER_AGENT_POOL` pick (a stealth page whose
   * policy lets the plugin choose, and which declared no UA). Such a UA is not
   * part of a persistent context's identity: the first launch's pick sticks.
   */
  rotating: boolean;
}

/**
 * Pick the User-Agent for a browser context from the crawl policy in scope —
 * `HttpClient`'s rules (Spec 1690 §4.2), except that in mode `plugin` with no
 * declared UA the pool the browser always used stands in for the plugin's choice
 * (where `HttpClient` falls back to the configured UA):
 *
 * | Resolved `userAgentMode`   | Context UA                                                   |
 * |----------------------------|--------------------------------------------------------------|
 * | `identify` / `strict`      | the configured UA (`policy.userAgent`), stealth or not       |
 * | `plugin` (global, operator, caller, or a plugin manifest opt-in) | `declared` if any, else a random `USER_AGENT_POOL` entry under stealth, else `USER_AGENT_POOL[0]` |
 *
 * A plugin manifest opt-in (`userAgentMode: 'plugin'`) already resolves to mode
 * `plugin` under `identify`, and is dropped by the resolver under `strict`.
 * Under `plugin` with no declared UA the pool is exactly the pre-1690 behaviour,
 * so `EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin` reproduces it.
 *
 * `legacy: true` (the `legacy` preset's own identity, see `isLegacyBrowserIdentity`)
 * is the pre-1690 pool whatever the mode: a random `USER_AGENT_POOL` entry under
 * stealth, else `USER_AGENT_POOL[0]` (a declared UA is ignored — pre-1690 pages had
 * none), so the `legacy` preset alone reproduces pre-1690 pages (and
 * persistent-profile keys) byte for byte, as `HttpClient`'s legacy precedence does.
 *
 * The declared UA is taken literally, minus what a header cannot carry (CR/LF and
 * other control characters); an empty one counts as not declared. Stealth patches
 * and viewports are not decided here — they stay as the caller asked.
 */
export function resolveBrowserUserAgent(
  policy: Pick<CrawlPolicy, 'userAgent' | 'userAgentMode'>,
  opts: { userAgent?: string; stealth?: boolean; legacy?: boolean } = {},
  pick: (pool: readonly string[]) => string = pickRandom,
): BrowserUserAgentChoice {
  if (policy.userAgentMode === 'plugin' || opts.legacy === true) {
    // Pre-1690 pages had no declared UA at all: under `legacy` only the pool counts.
    const declared = typeof opts.userAgent === 'string' && !opts.legacy ? sanitizeHeaderValue(opts.userAgent) : '';
    if (declared) return { userAgent: declared, source: 'declared', rotating: false };
    if (opts.stealth) return { userAgent: pick(USER_AGENT_POOL), source: 'pool', rotating: true };
    return { userAgent: BROWSER_POOL_DEFAULT_USER_AGENT, source: 'pool', rotating: false };
  }
  const configured = typeof policy.userAgent === 'string' ? sanitizeHeaderValue(policy.userAgent) : '';
  return { userAgent: configured || EVER_JOBS_DEFAULT_USER_AGENT, source: 'configured', rotating: false };
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * True when the policy's identity is the `legacy` preset's own — preset `legacy`,
 * and neither the UA mode nor the UA was set by any other layer — i.e. when
 * `BrowserPool` must behave exactly as before Spec 1690 (see
 * `resolveBrowserUserAgent`'s `legacy`).
 */
export function isLegacyBrowserIdentity(
  policy: Pick<ResolvedCrawlPolicy, 'userAgentMode' | 'provenance'>,
  preset: string = readCrawlPolicyEnv().preset,
): boolean {
  return (
    preset === 'legacy' &&
    policy.userAgentMode === 'strict' &&
    policy.provenance?.userAgentMode === 'preset' &&
    (policy.provenance?.userAgent === undefined || policy.provenance.userAgent === 'preset')
  );
}

/**
 * Options of `BrowserPool.navigate` — Playwright's `page.goto` options
 * (`waitUntil`, `timeout`, `referer`), passed through unchanged.
 */
export type BrowserNavigateOptions = Parameters<Page['goto']>[1];

/** What `getPage` remembers about a page for `navigate` (pages it did not create have none). */
interface PageCrawlInfo {
  /** The page's per-page crawl options (plugin layer), as passed to `getPage`. */
  crawl?: CrawlPolicyOverride;
  /** The proxy the page's context was launched with, if any. */
  proxy?: string;
  /** The context's User-Agent (robots.txt group matching). */
  userAgent: string;
}

/** Schemes a navigation may use without touching the network (no policy applies). */
const LOCAL_NAVIGATION_SCHEMES: ReadonlySet<string> = new Set(['about:', 'data:', 'blob:']);

/** Bytes of robots.txt downloaded at most (the cache parses the first 512 KiB), as `HttpClient`. */
const ROBOTS_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

/** Reject with the signal's reason as soon as it aborts; the promise itself is left to settle quietly. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReasonOf(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReasonOf(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Hide proxy credentials (`//user:pass@`, `|user:pass@`) in a persistent-context key before it is logged. */
export function redactBrowserIdentityKey(key: string): string {
  return key.replace(/(:\/\/|\|)[^|@\s/]+@/g, '$1***@');
}

/** Options passed to `BrowserPool.getPage()`. */
export interface BrowserPageOptions {
  /** Proxy server URL (e.g. `http://proxy:8080` or `socks5://proxy:1080`). */
  proxy?: string;
  /** Navigation timeout in seconds (used by the caller, not the pool). */
  timeout?: number;
  /**
   * Enable stealth mode for anti-bot evasion.
   * When true, injects scripts to mask webdriver detection, randomizes
   * UA/viewport, and patches browser fingerprinting APIs.
   * Default: false (backwards-compatible).
   */
  stealth?: boolean;
  /**
   * Use a headful (visible) browser instead of the default headless Chromium.
   * Useful for Cloudflare or other bot-detection that rejects headless contexts.
   *
   * Honored only when `EVER_JOBS_BROWSER_HEADFUL` is not `false`; see
   * `headfulEnabled`. A headful request always uses a persistent context.
   */
  headful?: boolean;
  /**
   * Root directory for persistent context profiles. Each distinct launch
   * identity (headful / stealth / proxy / User-Agent / `From`) gets its own
   * profile *underneath* this root — see `profileDirFor`.
   */
  userDataDir?: string;
  /**
   * The User-Agent this caller *declares* for the page (Spec 1690 §4.2). It is
   * used only when the crawl policy in scope resolves to `userAgentMode:
   * 'plugin'` — set globally (`EVER_JOBS_CRAWL_USER_AGENT_MODE`), per site/host by
   * the operator, by the search caller, or by the plugin's manifest opt-in
   * (`@SourcePlugin({ crawl: { userAgentMode: 'plugin', userAgentReason } })`).
   * Otherwise the configured Ever Jobs UA is used. See `resolveBrowserUserAgent`.
   */
  userAgent?: string;
  /**
   * Hostname or URL the page will navigate to first, if known. Selects the
   * builtin-host and operator-host crawl-policy layers (`EVER_JOBS_CRAWL_POLICIES`
   * `hosts[...]`) for this context's identity; without it only the site-level
   * layers apply.
   */
  host?: string;
  /**
   * Per-page crawl-policy options — the plugin layer, like the options a plugin
   * passes to `createHttpClient` (operator and caller layers still win).
   */
  crawl?: CrawlPolicyOverride;
}

/**
 * The inputs that decide whether two persistent-context requests may share one
 * Chromium profile. Chromium locks a profile directory to a single process, and
 * these options can only be applied at launch, so requests that disagree on any
 * of them need separate profiles rather than silent reuse.
 */
interface PersistentIdentity {
  headful: boolean;
  stealth: boolean;
  proxy?: string;
  /**
   * The context's User-Agent. Omitted when the UA is what the pool picked for
   * this identity before Spec 1690 (a random stealth pick, or `USER_AGENT_POOL[0]`
   * for a plain page), so those identities keep their pre-1690 profile directory.
   */
  userAgent?: string;
  /** The `From:` header the context sends (`EVER_JOBS_CRAWL_FROM`), if any. */
  from?: string;
}

/**
 * Shared singleton browser pool for Chromium scraping.
 *
 * Usage:
 *   const page = await BrowserPool.getPage();
 *   try {
 *     await BrowserPool.navigate(page, url, { waitUntil: 'domcontentloaded' });
 *     ...
 *   } finally { await page.close(); }
 *
 * Navigate with `BrowserPool.navigate(page, url, options)`, never `page.goto`:
 * it applies the crawl policy (egress guard, robots.txt, per-host pacing, abort,
 * 429/503 back-off) the way `HttpClient` does for HTTP requests.
 *
 * For anti-bot protected sites:
 *   const page = await BrowserPool.getPage({ stealth: true, proxy, headful: true });
 *
 * The context's User-Agent follows the crawl policy (Spec 1690): the configured
 * Ever Jobs UA by default; a UA the caller declares (`userAgent`) or the stealth
 * pool only when the policy's `userAgentMode` resolves to `plugin`:
 *   const page = await BrowserPool.getPage({ userAgent: MY_UA, host: url });
 *
 * Call `BrowserPool.close()` on app shutdown (e.g. `onModuleDestroy`).
 */
export class BrowserPool {
  private static browser: Browser | null = null;
  private static launching: Promise<Browser> | null = null;
  /** Live persistent contexts, keyed by launch identity (see `identityKey`). */
  private static readonly persistentContexts: Map<string, BrowserContext> = new Map();
  private static readonly persistentLaunching: Map<string, Promise<BrowserContext>> = new Map();
  /**
   * Contexts Playwright has told us are gone. A `BrowserContext` exposes no
   * `isConnected()`, so liveness is tracked by subscribing to its `close` event
   * rather than inferred from a method call that cannot fail.
   */
  private static readonly closedContexts = new WeakSet<BrowserContext>();
  /** Contexts the stealth init script has already been registered on. */
  private static readonly stealthApplied = new WeakSet<BrowserContext>();
  /** The blank page `launchPersistentContext` opens for us, pending disposal. */
  private static readonly initialPages = new WeakMap<BrowserContext, Page[]>();
  /** What `getPage` knew about each page it handed out (`navigate` reads it). */
  private static readonly pageCrawl = new WeakMap<object, PageCrawlInfo>();
  /**
   * The client robots.txt is fetched with for `navigate` (lazily built): its
   * interceptor applies the configured identity and the egress guard.
   */
  private static navigationHttp?: HttpClient;
  private static readonly logger = new Logger(BrowserPool.name);

  /** Default Chromium launch options. */
  private static readonly DEFAULT_OPTS: LaunchOptions = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };

  /** Root directory holding persistent context profiles. */
  private static get defaultUserDataDir(): string {
    return process.env.PLAYWRIGHT_USER_DATA_DIR ?? join(homedir(), '.cache', 'ever-jobs', 'chromium-profile');
  }

  /**
   * Whether a `headful: true` request is honored. Headful needs a display
   * server, which no deployed environment has, so this is the kill switch that
   * forces every caller back onto the headless path without a code change.
   */
  private static get headfulEnabled(): boolean {
    return process.env.EVER_JOBS_BROWSER_HEADFUL !== 'false';
  }

  /**
   * Default (non-stealth) pool User-Agent string — used only when the crawl
   * policy lets the plugin choose and it declared none (see
   * `resolveBrowserUserAgent`).
   */
  private static readonly DEFAULT_USER_AGENT = BROWSER_POOL_DEFAULT_USER_AGENT;

  /** Default cap on live persistent contexts (see {@link maxPersistentContexts}). */
  static readonly DEFAULT_MAX_PERSISTENT_CONTEXTS = 4;

  /**
   * Most persistent contexts kept alive at once (Spec 1689). Each distinct
   * identity — and the identity includes a caller-supplied proxy — launches
   * its own Chromium process and profile directory, so a caller rotating
   * proxy strings could otherwise grow Chromium processes until shutdown.
   * Over the cap, the least-recently-used IDLE context (no open page) is
   * closed before a new one launches; a context with a page in use is never
   * closed under its caller. `EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS`
   * sets it; `0` = unbounded (the previous behaviour).
   */
  private static get maxPersistentContexts(): number {
    const raw = process.env.EVER_JOBS_BROWSER_MAX_PERSISTENT_CONTEXTS?.trim();
    if (!raw) return this.DEFAULT_MAX_PERSISTENT_CONTEXTS;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : this.DEFAULT_MAX_PERSISTENT_CONTEXTS;
  }

  /** Pick a random element from an array. */
  private static pick<T>(arr: readonly T[]): T {
    return pickRandom(arr);
  }

  /**
   * Get (or lazily launch) a shared Chromium browser instance.
   */
  static async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Prevent multiple concurrent launches
    if (this.launching) return this.launching;

    this.launching = (async () => {
      try {
        this.logger.log('Launching headless Chromium…');
        // Dynamic import — playwright may not be installed in all environments
        const { chromium } = await import('playwright');
        const browser = await chromium.launch(this.DEFAULT_OPTS);
        this.browser = browser;
        this.logger.log('Chromium launched');
        return browser;
      } catch (err) {
        // Reset the guard so subsequent calls can retry the launch
        this.launching = null;
        throw err;
      }
    })();

    return this.launching;
  }

  /**
   * Cache key for a persistent context: the profile root plus its identity.
   * The User-Agent and `From` parts are appended only when present, so an
   * identity without them keeps its pre-1690 key (and profile directory).
   */
  private static identityKey(userDataDir: string, identity: PersistentIdentity): string {
    let key = `${userDataDir}|${identity.headful}|${identity.stealth}|${identity.proxy ?? ''}`;
    if (identity.userAgent !== undefined) key += `|ua=${identity.userAgent}`;
    if (identity.from !== undefined) key += `|from=${identity.from}`;
    return key;
  }

  /**
   * Profile directory for one launch identity, nested under the configured
   * root. Two requests that disagree on proxy, stealth, headfulness,
   * User-Agent or `From` cannot share a profile — Chromium locks the directory
   * to one process, a session pinned to one egress IP must not be replayed
   * through another, and a UA is fixed at launch — so each identity gets a
   * deterministic sibling directory instead.
   */
  private static profileDirFor(userDataDir: string, identity: PersistentIdentity): string {
    const digest = createHash('sha1')
      .update(this.identityKey('', identity))
      .digest('hex')
      .slice(0, 8);
    return join(userDataDir, digest);
  }

  /**
   * Get (or lazily launch) a persistent Chromium context for one launch
   * identity. Contexts are cached per identity, never per directory alone —
   * caching on the directory would silently impose the first caller's proxy,
   * User-Agent and viewport on every later caller.
   */
  static async getPersistentContext(
    userDataDir: string,
    identity: PersistentIdentity,
    ctxOpts: BrowserContextOptions,
  ): Promise<BrowserContext> {
    const key = this.identityKey(userDataDir, identity);

    const existing = this.persistentContexts.get(key);
    if (existing && this.isContextUsable(existing)) {
      // most-recently-used last (Map iteration order is the LRU order)
      this.persistentContexts.delete(key);
      this.persistentContexts.set(key, existing);
      return existing;
    }
    // A context that closed under us must not be handed out again.
    if (existing) this.persistentContexts.delete(key);

    const launching = this.persistentLaunching.get(key);
    if (launching) return launching;

    const profileDir = this.profileDirFor(userDataDir, identity);
    const promise = (async () => {
      // This launch is not in `persistentLaunching` yet (the map is written
      // after the IIFE yields), so reserve one slot for it plus one per
      // launch already in flight.
      await this.evictIdleOverCap(this.persistentLaunching.size + 1);
      this.logger.log(
        `Launching persistent Chromium context (headful=${identity.headful}) at ${profileDir}…`,
      );
      const { chromium } = await import('playwright');
      const context = await chromium.launchPersistentContext(profileDir, {
        ...this.DEFAULT_OPTS,
        ...ctxOpts,
        headless: identity.headful ? false : this.DEFAULT_OPTS.headless,
      });

      // `launchPersistentContext` opens a blank page we never asked for. Hold
      // it until the caller's first real page exists, then dispose of it —
      // closing every page of a persistent context can take the context down.
      this.initialPages.set(context, context.pages());

      context.on('close', () => {
        this.closedContexts.add(context);
        this.evictContext(context);
      });

      this.persistentContexts.set(key, context);
      this.logger.log('Persistent Chromium context launched');
      // Re-check now that this context is cached: launches that overlapped
      // this one may have left idle contexts over the cap. This launch is
      // still in `persistentLaunching`, so it is not reserved twice.
      await this.evictIdleOverCap(Math.max(0, this.persistentLaunching.size - 1));
      return context;
    })();

    this.persistentLaunching.set(key, promise);
    // Clear the in-flight guard on both paths: leaving a settled promise in the
    // map made a failed launch un-retryable until the process restarted.
    return promise.finally(() => this.persistentLaunching.delete(key));
  }

  /**
   * Create a fresh page with configurable stealth level.
   * The caller is responsible for closing the page when done.
   *
   * The context's User-Agent (and `From:` header) come from the crawl policy in
   * scope — `getEffectiveCrawlPolicy(opts.host, opts.crawl)` inside the scrape
   * context — see `resolveBrowserUserAgent` (Spec 1690 §4.2).
   *
   * @param opts.proxy      — route all traffic through this proxy server
   * @param opts.stealth    — enable anti-bot evasion (viewport rotation, JS patches;
   *                          a random pool UA only when the policy lets the plugin choose)
   * @param opts.headful    — launch a headful persistent context (see `headfulEnabled`)
   * @param opts.userDataDir — root directory for persistent context profiles
   * @param opts.userAgent  — the UA this caller declares (used in policy mode `plugin`)
   * @param opts.host       — hostname / URL of the first navigation (host-scoped policy)
   * @param opts.crawl      — per-page crawl-policy options (plugin layer)
   */
  static async getPage(opts?: BrowserPageOptions): Promise<Page> {
    const stealth = opts?.stealth ?? false;
    const headful = this.resolveHeadful(opts?.headful ?? false);
    const wantsPersistent = headful || !!opts?.userDataDir;

    // Spec 1690 §4.6: a scrape the search deadline aborted opens no new page, and
    // the pages it has open are closed when it aborts (see `closeOnAbort`).
    const scrape = getScrapeContext();
    const signal = scrape?.signal;
    if (signal?.aborted) throw abortReasonOf(signal);

    const env = readCrawlPolicyEnv();
    const policy = getEffectiveCrawlPolicy(opts?.host, opts?.crawl);
    const manifest = scrape?.plugin && crawlPluginManifestsEnabled(env) ? scrape.plugin : undefined;
    const ua = resolveBrowserUserAgent(
      policy,
      {
        // Every plugin-layer UA is a declaration (Spec 1690 §4.2): the option,
        // then the page's `crawl.userAgent`, then the plugin manifest's.
        userAgent:
          opts?.userAgent ??
          this.declaredCrawlUserAgent(opts?.crawl?.userAgent, env.contact) ??
          this.declaredCrawlUserAgent(manifest?.userAgent, env.contact),
        stealth,
        legacy: isLegacyBrowserIdentity(policy, env.preset),
      },
      (pool) => this.pick(pool),
    );
    const from = typeof policy.from === 'string' ? sanitizeHeaderValue(policy.from) || undefined : undefined;

    const ctxOpts: BrowserContextOptions = {
      userAgent: ua.userAgent,
      viewport: stealth ? this.pick(VIEWPORT_POOL) : { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      javaScriptEnabled: true,
    };

    if (from) {
      ctxOpts.extraHTTPHeaders = { From: from };
    }

    if (opts?.proxy) {
      ctxOpts.proxy = { server: opts.proxy };
    }

    // For `navigate`: the page-level crawl options, proxy and context UA.
    const info: PageCrawlInfo = { userAgent: ua.userAgent };
    if (opts?.crawl) info.crawl = opts.crawl;
    if (opts?.proxy) info.proxy = opts.proxy;

    if (wantsPersistent) {
      const userDataDir = opts?.userDataDir ?? this.defaultUserDataDir;
      const identity: PersistentIdentity = {
        headful,
        stealth,
        proxy: opts?.proxy,
        userAgent: this.identityUserAgent(ua, stealth),
        from,
      };
      const context = await this.getPersistentContext(userDataDir, identity, ctxOpts);
      await this.applyStealthToContext(context, stealth);
      const page = await context.newPage();
      await this.disposeInitialPages(context);
      this.pageCrawl.set(page, info);
      // A persistent context is shared: only this page goes on abort.
      return this.closeOnAbort(page, signal, () => page.close());
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext(ctxOpts);
    await this.applyStealthToContext(context, stealth);
    const page = await context.newPage();
    this.pageCrawl.set(page, info);
    // This context exists for this page alone: closing it closes the page too.
    return this.closeOnAbort(page, signal, () => context.close());
  }

  /**
   * Navigate `page` to `url` under the crawl policy (Spec 1690) — the browser
   * counterpart of `HttpClient.request()`, and what every plugin should call
   * instead of `page.goto`. For the URL's host, with the policy resolved from the
   * scrape context in scope (`getEffectiveCrawlPolicy`, plus the page's `crawl`
   * options from `getPage`):
   *
   * 1. **abort** — a scrape the deadline aborted navigates nowhere; an abort
   *    while queued, resolving or loading rejects at once with its reason;
   * 2. **egress guard** (`blockPrivateNetworks`) — the literal check
   *    (`assertPublicHostname`) before anything else; a page launched with a
   *    proxy that is not one of the operator's env proxies has that proxy
   *    checked too; for a page `getPage` created without a proxy, the name is
   *    resolved once right before `page.goto` and refused when any answer is
   *    private (`assertPublicResolution`). The browser's own resolver is not
   *    hooked, so this is best effort against DNS rebinding (a record that
   *    changes between the two lookups is not caught), and redirects inside the
   *    browser are not checked. Non-http(s) URLs other than `about:`, `data:` and
   *    `blob:` are refused under the guard;
   * 3. **robots.txt** (`robotsTxt` not `off`) — the shared `getRobotsTxtCache()`,
   *    fetched through an `HttpClient` (configured identity, egress guard) with a
   *    slot from the host limiter; `respect` refuses a disallowed URL with
   *    `RobotsDisallowedError`, a `Crawl-delay` raises the bucket's interval;
   * 4. **pacing** — a `HostLimiter` slot for the URL's bucket, held for the whole
   *    navigation (released when `page.goto` settles);
   * 5. **back-off** — a 429/503 navigation response feeds the adaptive throttle
   *    and cools the bucket (`recordAnswerOutcome`), as `HttpClient` does for an
   *    answer it hands back. The response is still returned: the page loaded.
   *
   * `options` go to `page.goto` unchanged, and `page.goto` is what performs the
   * navigation — so any object with a `goto` works (plugin test fakes, or a page
   * of a Chromium the plugin launched itself; pages `getPage` did not create skip
   * only the DNS pre-check, since their proxy is unknown).
   * `EVER_JOBS_CRAWL_BROWSER_NAVIGATION=false` (the `legacy` preset's default)
   * makes this exactly `page.goto(url, options)`.
   */
  static async navigate(
    page: Pick<Page, 'goto'>,
    url: string,
    options?: BrowserNavigateOptions,
  ): Promise<PlaywrightResponse | null> {
    const env = readCrawlPolicyEnv();
    if (!crawlBrowserNavigationEnabled(env)) return page.goto(url, options);

    const scrape = getScrapeContext();
    const signal = scrape?.signal;
    if (signal?.aborted) throw abortReasonOf(signal);

    let target: URL | null = null;
    try {
      target = new URL(url);
    } catch {
      target = null;
    }
    const info = this.pageCrawl.get(page);
    const policy = getEffectiveCrawlPolicy(target?.hostname || undefined, info?.crawl);

    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      // No host to pace or guard: a local document passes; anything else
      // (file:, ftp:, chrome:…, or no URL at all) is refused under the guard.
      if (target && LOCAL_NAVIGATION_SCHEMES.has(target.protocol)) return page.goto(url, options);
      if (policy.blockPrivateNetworks) {
        const what = target ? `${target.protocol} URL` : describeUrlForLog(url);
        throw new EgressBlockedError(what, 'only http(s) navigations are allowed');
      }
      return page.goto(url, options);
    }

    if (policy.blockPrivateNetworks) {
      assertPublicHostname(target.hostname);
      if (info?.proxy && !env.proxies.includes(info.proxy)) assertPublicProxy(info.proxy);
    }

    const limiter = getHostLimiter();
    const bucket = bucketKeyFor(target.href, policy.rateLimitScope, scrape?.site);

    let crawlDelayMs = 0;
    if (policy.robotsTxt !== 'off') {
      const robotsUa = info?.userAgent ?? policy.userAgent;
      const decision = await raceAbort(
        getRobotsTxtCache().check(target.href, robotsUa, policy.robotsTxt, (robotsUrl) =>
          this.fetchRobotsTxt(robotsUrl, policy, scrape?.site, signal),
        ),
        signal,
      );
      if (!decision.allowed) throw new RobotsDisallowedError(`${target.origin}${target.pathname}`);
      // A site's Crawl-delay is honoured up to the limiter's cool-down ceiling.
      crawlDelayMs = Math.min(decision.crawlDelayMs ?? 0, limiter.maxCooldownMs);
    }

    const release = await limiter.acquire(bucket, crawlAcquireOptions(policy, signal, crawlDelayMs));
    try {
      if (policy.blockPrivateNetworks && info && !info.proxy) {
        // Right before the browser connects, to keep the rebinding window small.
        await raceAbort(assertPublicResolution(target.hostname), signal);
      }
      const response = await raceAbort(page.goto(url, options), signal);
      this.recordNavigation(bucket, policy, target, response);
      return response;
    } finally {
      release();
    }
  }

  /** Feed a navigation's response status to the limiter (`recordAnswerOutcome`). */
  private static recordNavigation(
    bucket: string,
    policy: CrawlPolicy,
    target: URL,
    response: PlaywrightResponse | null | undefined,
  ): void {
    if (!response || typeof response.status !== 'function') return;
    let status: number | undefined;
    let headers: Record<string, string> | undefined;
    try {
      status = response.status();
      headers = typeof response.headers === 'function' ? response.headers() : undefined;
    } catch {
      return;
    }
    if (typeof status !== 'number') return;
    const outcome = recordAnswerOutcome(getHostLimiter(), bucket, policy, 0, status, headers);
    if (outcome.giveUpAfterMs !== undefined) {
      this.logger.warn(
        `Navigation to ${describeUrlForLog(target.href)} answered ${status}, Retry-After ${outcome.giveUpAfterMs}ms ` +
          `exceeds maxRetryAfterMs ${policy.maxRetryAfterMs}ms (${bucket} cooling down)`,
      );
    } else if (outcome.backOffMs !== undefined) {
      this.logger.debug(
        `Navigation to ${describeUrlForLog(target.href)} answered ${status}; ${bucket} backs off ${outcome.backOffMs}ms`,
      );
    }
  }

  /**
   * robots.txt fetcher for `navigate` (Spec 1690 §4.7): a slot from the host
   * limiter for the robots.txt bucket, then a GET straight through the shared
   * `HttpClient`'s axios instance — whose interceptor applies the configured
   * identity (UA, `From`, no client hints) and the egress guard. Not through
   * `HttpClient.request()`: a robots.txt check there would wait on this very
   * fetch. Fetched directly, not through the page's proxy.
   */
  private static async fetchRobotsTxt(
    robotsUrl: string,
    policy: CrawlPolicy,
    site: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: string }> {
    const bucket = bucketKeyFor(robotsUrl, policy.rateLimitScope, site);
    const release = await getHostLimiter().acquire(bucket, crawlAcquireOptions(policy, signal));
    try {
      const response = await this.robotsHttpClient().getAxiosInstance().request({
        url: robotsUrl,
        method: 'GET',
        headers: { Accept: 'text/plain, */*;q=0.5' },
        responseType: 'text',
        maxContentLength: ROBOTS_MAX_DOWNLOAD_BYTES,
        validateStatus: () => true,
        ...(signal ? { signal } : {}),
      });
      const body = typeof response.data === 'string' ? response.data : response.data == null ? '' : String(response.data);
      return { status: response.status, body };
    } finally {
      release();
    }
  }

  /** The shared client robots.txt is fetched with (see `fetchRobotsTxt`). */
  private static robotsHttpClient(): HttpClient {
    if (!this.navigationHttp) this.navigationHttp = new HttpClient();
    return this.navigationHttp;
  }

  /**
   * Close `page` (through `close`) when the scrape's `signal` aborts — no orphan
   * browser traffic after the search stopped listening (Spec 1690 §4.6). An
   * already-aborted signal closes it at once and rejects with the abort reason.
   */
  private static async closeOnAbort(
    page: Page,
    signal: AbortSignal | undefined,
    close: () => Promise<unknown>,
  ): Promise<Page> {
    if (!signal) return page;
    const closeQuietly = (): void => {
      close().catch((err) => this.logger.debug(`Closing an aborted scrape's page failed: ${err?.message ?? err}`));
    };
    if (signal.aborted) {
      closeQuietly();
      throw abortReasonOf(signal);
    }
    const onAbort = (): void => closeQuietly();
    signal.addEventListener('abort', onAbort, { once: true });
    if (typeof page.once === 'function') page.once('close', () => signal.removeEventListener('abort', onAbort));
    return page;
  }

  /** A `crawl.userAgent` declared at the plugin layer: header-safe, keywords expanded. */
  private static declaredCrawlUserAgent(value: unknown, contact: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = sanitizeHeaderValue(value);
    return clean ? expandUserAgent(clean, contact) : undefined;
  }

  /**
   * Gracefully shut down the browser and all persistent contexts.
   * Safe to call multiple times.
   */
  static async close(): Promise<void> {
    for (const [key, context] of this.persistentContexts) {
      this.logger.log(`Closing persistent Chromium context ${redactBrowserIdentityKey(key)}…`);
      await context.close().catch(() => {});
    }
    this.persistentContexts.clear();
    this.persistentLaunching.clear();
    this.launching = null;

    if (this.browser) {
      this.logger.log('Closing Chromium…');
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** Honor `headful` only where a display server can plausibly exist. */
  private static resolveHeadful(requested: boolean): boolean {
    if (!requested) return false;
    if (this.headfulEnabled) return true;

    this.logger.warn(
      'Headful browser requested but EVER_JOBS_BROWSER_HEADFUL=false — using headless',
    );
    return false;
  }

  /**
   * The User-Agent part of a persistent identity: omitted for the UA the pool
   * picked for this identity before Spec 1690 (a random stealth pick — the first
   * launch's pick sticks, as before — or `USER_AGENT_POOL[0]` on a plain page),
   * otherwise the exact UA, so a context launched with one UA is never reused for
   * another.
   */
  private static identityUserAgent(ua: BrowserUserAgentChoice, stealth: boolean): string | undefined {
    if (ua.rotating) return undefined;
    if (!stealth && ua.userAgent === this.DEFAULT_USER_AGENT) return undefined;
    return ua.userAgent;
  }

  /**
   * Register the shared stealth init script on a context, once. Playwright
   * accumulates init scripts per context and replays all of them into every new
   * page, so re-registering on each `getPage()` against a long-lived persistent
   * context grew without bound.
   */
  private static async applyStealthToContext(context: BrowserContext, stealth: boolean): Promise<void> {
    if (!stealth || this.stealthApplied.has(context)) return;

    await context.addInitScript(STEALTH_INIT_SCRIPT);
    this.stealthApplied.add(context);
  }

  /** Close the blank page Playwright opened with a persistent context. */
  private static async disposeInitialPages(context: BrowserContext): Promise<void> {
    const pending = this.initialPages.get(context);
    if (!pending?.length) return;

    this.initialPages.delete(context);
    for (const page of pending) {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
  }

  /** Whether a cached persistent context is still usable. */
  private static isContextUsable(context: BrowserContext): boolean {
    return !this.closedContexts.has(context);
  }

  /**
   * Keep live persistent contexts within {@link maxPersistentContexts}: close
   * the least-recently-used contexts that have no open page until the cached
   * contexts plus `reserved` slots fit under the cap. When every context is
   * busy the launch goes ahead over the cap (a scrape in flight is never cut
   * off) and says so.
   *
   * `reserved` counts launches that are still in flight — they are not in
   * `persistentContexts` yet, so without it a burst of concurrent launches
   * with different identities would each see the old size, evict nothing, and
   * leave the pool over the cap once they land.
   */
  private static async evictIdleOverCap(reserved: number): Promise<void> {
    const cap = this.maxPersistentContexts;
    if (cap <= 0) return;
    const over = (): boolean => this.persistentContexts.size + reserved > cap;
    for (const [key, context] of [...this.persistentContexts]) {
      if (!over()) return;
      const open = context.pages().filter((page) => !page.isClosed());
      if (open.length > 0) continue;
      // unmapped first, so its 'close' event is not reported as unexpected
      this.persistentContexts.delete(key);
      this.logger.log(`Closing idle persistent Chromium context ${redactBrowserIdentityKey(key)} (over the cap of ${cap})`);
      await context.close().catch(() => undefined);
    }
    if (over()) {
      this.logger.warn(
        `${this.persistentContexts.size} persistent Chromium contexts are busy ` +
          `(${reserved} slot(s) reserved for launches); over the cap of ${cap}`,
      );
    }
  }

  /** Drop a dead context so the next request relaunches instead of reusing it. */
  private static evictContext(context: BrowserContext): void {
    for (const [key, cached] of this.persistentContexts) {
      if (cached === context) {
        this.persistentContexts.delete(key);
        this.logger.warn(`Persistent Chromium context closed unexpectedly (${redactBrowserIdentityKey(key)}) — evicted`);
        return;
      }
    }
  }
}
