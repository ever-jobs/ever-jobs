import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ScraperInputDto } from '@ever-jobs/models';

import { getRequestId } from '../context';
import { describeUrlForLog, pinUrlToHosts } from '../utils/url-guard';
import {
  EgressGuardOptions,
  assertPublicHostname,
  assertPublicProxy,
  createGuardedLookup,
  getGuardedAgents,
  isEgressAllowListed,
} from './crawl/egress-guard';
import { crawlPluginManifestsEnabled, expandUserAgent, readCrawlPolicyEnv } from './crawl/env';
import { CrawlPolicyError, HostCoolingDownError, RobotsDisallowedError } from './crawl/errors';
import {
  HostLimiter,
  HostLimiterAcquireExtraOptions,
  abortReasonOf,
  bucketKeyFor,
  getHostLimiter,
} from './crawl/host-limiter';
import { sanitizeHeaderValue } from './crawl/policy-schema';
import { ProxyRotationState, createProxyRotationState, selectProxy } from './crawl/proxy-selector';
import { RobotsFetcher, RobotsTxtCache, getRobotsTxtCache } from './crawl/robots';
import { getEffectiveCrawlPolicy, getEffectiveProxies, getScrapeContext, runWithScrapeContext } from './crawl/scrape-context';
import { CrawlPolicy, CrawlPolicyOverride, HostLimiterAcquireOptions, ResolvedCrawlPolicy, ScrapeContext } from './crawl/types';

/**
 * Query-string keys whose values must never reach a log line. Several sources
 * authenticate by query parameter (`source-ats-ceipal` `api_key`,
 * `source-ats-jazzhr` `apikey`, `source-ats-teamtailor` / `source-ats-talentera`
 * / `source-ats-comeet` `token`), so naming the raw URL on retry would copy
 * those credentials into the pod logs.
 */
const SENSITIVE_QUERY_KEYS =
  /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|auth|authorization|signature|sig|session|credentials?)$/i;

/**
 * Hosts that carry a credential in the URL *path* rather than the query string,
 * mapped to the zero-based index of the offending path segment. Ceipal routes
 * every tenant call through `https://api.ceipal.com/{apiKey}/job-postings/`, so
 * the first segment is the tenant's career-portal key — `CeipalService` already
 * masks it in its own logs (`maskKey`), and the shared retry line must not undo
 * that. `source-ats-ceipal` is currently the only plugin that builds a URL this
 * way; add a row here if another one appears.
 */
const SENSITIVE_PATH_SEGMENTS: Record<string, number> = {
  'api.ceipal.com': 0,
};

/** Scheme + authority of an absolute URL, e.g. `https://api.ceipal.com:443`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/** An absolute URL (axios treats anything else as relative to `baseURL`). */
const ABSOLUTE_URL = /^[a-z][a-z\d+\-.]*:\/\//i;

/** `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, … (Spec 1690 §4.2). */
const CLIENT_HINT_HEADER = /^sec-ch-ua/i;

/** Longest delay `setTimeout` honours; anything longer fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Bytes of robots.txt downloaded at most (the cache parses the first 512 KiB). */
const ROBOTS_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Config key carrying the per-attempt identity from `request()` to the request
 * interceptor. A string key: axios' `mergeConfig` keeps unknown string keys and
 * drops symbols. The interceptor deletes it before the adapter sees the config.
 */
const IDENTITY_KEY = '__everJobsCrawlIdentity';

/** Environment variables through which axios (proxy-from-env) routes via a forward proxy. */
const ENV_PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/**
 * axios' own resolver of `HTTP(S)_PROXY` / `NO_PROXY` (the `proxy-from-env`
 * package axios depends on), loaded lazily; null when it cannot be loaded, in
 * which case an env-configured proxy keeps the axios default agents as before.
 */
let proxyForUrl: ((url: string) => string) | null | undefined;
function envProxyFor(url: string): string | null {
  if (proxyForUrl === undefined) {
    try {
      const mod = require('proxy-from-env') as { getProxyForUrl?: (url: string) => string };
      proxyForUrl = typeof mod?.getProxyForUrl === 'function' ? mod.getProxyForUrl : null;
    } catch {
      proxyForUrl = null;
    }
  }
  if (!proxyForUrl) return null;
  try {
    return proxyForUrl(url) || '';
  } catch {
    return null;
  }
}

/**
 * Transport-level error codes worth a retry when `retryOnNetworkError` is on: the
 * connection failed or broke, not the request. `ENOTFOUND` (the name does not
 * exist) and cancellations are deliberately absent.
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ERR_NETWORK',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * `false` turns {@link HttpClientOptions.allowedRedirectHosts} off process-wide
 * (redirects are followed as axios does by default) — an escape hatch should a
 * pinned site start redirecting somewhere legitimate. Default on.
 */
export const HTTP_PIN_REDIRECTS_ENV = 'EVER_JOBS_HTTP_PIN_REDIRECTS';

function redirectPinningEnabled(): boolean {
  const raw = process.env[HTTP_PIN_REDIRECTS_ENV]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/**
 * The `beforeRedirect` hook for a pinned client: every hop must itself be an
 * https URL on `allowedHosts` (or a subdomain), checked by the same
 * {@link pinUrlToHosts} the plugin ran on the first URL. Throwing aborts the
 * redirect, so the request rejects instead of following it.
 */
export function redirectPinGuard(
  allowedHosts: readonly string[],
): (redirectOptions: Record<string, unknown>) => void {
  return (redirectOptions) => {
    const href = typeof redirectOptions.href === 'string' ? redirectOptions.href : '';
    if (!pinUrlToHosts(href, allowedHosts)) {
      throw new Error(
        `Refused redirect to ${describeUrlForLog(href)}: not an https URL on ${allowedHosts.join(', ')}`,
      );
    }
  };
}

export interface HttpClientOptions {
  proxies?: string[];
  caCert?: string;
  /**
   * A User-Agent this client's plugin *declares* (Spec 1690 §4.2) — recorded
   * separately from the configured UA and sent only when the resolved
   * `userAgentMode` lets the plugin choose (`plugin`, or `identify` with the
   * plugin layer's `userAgentMode: 'plugin'` opt-in). Under the `legacy` preset it
   * is the client's default UA, as before Spec 1690.
   */
  userAgent?: string;
  /** Maps to the plugin layer's `retries` (Spec 1690). */
  retries?: number;
  /** Base backoff between retries, in MILLISECONDS (default 1000). Maps to `retryBaseDelayMs`. */
  retryDelay?: number;
  /** Maps to `retryBackoff`; `'constant'` is available through `crawl.retryBackoff`. */
  retryBackoff?: 'linear' | 'exponential';
  /** Ceiling on any single retry wait, in MILLISECONDS (default 30000). Maps to `retryMaxDelayMs`. */
  retryMaxDelay?: number;
  /**
   * Per-request timeout in SECONDS (default 60) -- NOT milliseconds. It is
   * multiplied by 1000 below, so `timeout: 10000` asks for ~2.8 hours rather
   * than 10 seconds. The retry delays above are milliseconds; this one is not.
   */
  timeout?: number;
  /**
   * Minimum delay between requests in seconds (rate limiting). Enforced per
   * rate-limit bucket through the process-wide limiter (`minIntervalMs` =
   * min × 1000), so concurrent calls are spaced too. 0 / unset = no extra delay.
   */
  rateDelayMin?: number;
  /** Maximum delay between requests in seconds (rate limiting): `jitterMs` = (max − min) × 1000. */
  rateDelayMax?: number;
  /**
   * Enable cookie handling. When `true`, an isolated `CookieJar` is created for
   * this client. Pass a `CookieJar` instance to share state across requests.
   */
  cookies?: boolean | CookieJar;
  /**
   * Crawl-policy override for every request of this client (Spec 1690): the
   * plugin layer, applied over the pre-1690 fields above (these win on a clash).
   */
  crawl?: CrawlPolicyOverride;
  /**
   * The `Site` this client serves, used when no scrape context names one: it
   * selects the operator-site policy and the `site` rate-limit bucket.
   */
  site?: string;
  /** Hosts exempt from the egress guard for this client: exact host, `*.suffix` or IP literal. */
  egressAllowHosts?: string[];
  /** Limiter pacing this client's requests (default: the process-wide `getHostLimiter()`). */
  hostLimiter?: HostLimiter;
  /** robots.txt cache (default: the process-wide `getRobotsTxtCache()`). */
  robotsTxtCache?: RobotsTxtCache;
  /**
   * Pin every redirect hop to these hosts (Spec 1689). Unset (the default),
   * axios follows up to 21 redirects to any host and scheme, so a pinned
   * first URL on an allowlisted host with an open redirect could still land
   * on loopback, a private range or cloud metadata. Set, each hop must pass
   * `pinUrlToHosts(hop, allowedRedirectHosts)` — https only, same hosts or
   * their subdomains, no credentials or explicit port — or the request
   * rejects. `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns it off process-wide.
   *
   * Independent of the crawl policy's egress guard (Spec 1690 §4.8): when both
   * apply, a hop must pass the pin first, then the egress check, then any
   * `beforeRedirect` the request brought itself — through `request()` or
   * straight through `getAxiosInstance()`, guard on or off (`transportFor` /
   * `applyCrawlIdentity` compose the hooks).
   */
  allowedRedirectHosts?: readonly string[];
}

/**
 * `AxiosRequestConfig` plus a per-request crawl-policy override (Spec 1690). Pass
 * it to `get`/`post`/`request` as a typed variable; the override is applied over
 * the client's own (plugin layer) for that one request.
 */
export interface CrawlRequestConfig<D = any> extends AxiosRequestConfig<D> {
  crawl?: CrawlPolicyOverride;
}

/** The identity (User-Agent, `From`, client hints) one attempt goes out with. */
interface WireIdentity {
  userAgent: string;
  /** Drop `sec-ch-ua*` headers (the configured UA is sent and `stripClientHints` is on). */
  stripClientHints: boolean;
  from?: string;
}

/** Input to `selectWireUserAgent`. */
export interface WireUserAgentInput {
  policy: Pick<ResolvedCrawlPolicy, 'userAgent' | 'userAgentMode'>;
  /** UA carried by the request's own headers. */
  perRequest?: string;
  /** UA declared through `setHeaders()`. */
  setHeaders?: string;
  /** UA from the `userAgent` client option. */
  option?: string;
  /** The plugin layer (manifest or client `crawl` option) asked for `userAgentMode: 'plugin'`. */
  pluginOptIn?: boolean;
  /**
   * Pre-1690 precedence (the `legacy` preset's own `strict` mode): the request's
   * own UA header wins, else the `userAgent` option (the pre-1690 client-level
   * UA), else the configured UA; `setHeaders()` never reaches the wire — exactly
   * what the pre-1690 client did.
   */
  legacy?: boolean;
}

export type WireUserAgentSource = 'configured' | 'per-request' | 'set-headers' | 'option';

/**
 * Which User-Agent goes on the wire (Spec 1690 §4.2):
 *
 * | Mode       | Wire UA                                                                   |
 * |------------|---------------------------------------------------------------------------|
 * | `identify` | configured, unless the plugin layer opted into `plugin` → declared         |
 * | `strict`   | configured, always                                                        |
 * | `plugin`   | declared if any, else configured                                          |
 *
 * "Declared" = the request's own header, else `setHeaders()`, else the
 * `userAgent` option (the most specific declaration wins).
 */
export function selectWireUserAgent(input: WireUserAgentInput): { userAgent: string; source: WireUserAgentSource } {
  const configured = { userAgent: input.policy.userAgent, source: 'configured' as const };
  if (input.legacy) {
    if (input.perRequest) return { userAgent: input.perRequest, source: 'per-request' };
    return input.option ? { userAgent: input.option, source: 'option' } : configured;
  }
  const declared: { userAgent: string; source: WireUserAgentSource } | undefined = input.perRequest
    ? { userAgent: input.perRequest, source: 'per-request' }
    : input.setHeaders
      ? { userAgent: input.setHeaders, source: 'set-headers' }
      : input.option
        ? { userAgent: input.option, source: 'option' }
        : undefined;
  switch (input.policy.userAgentMode) {
    case 'plugin':
      return declared ?? configured;
    case 'identify':
      return input.pluginOptIn && declared ? declared : configured;
    default:
      return configured;
  }
}

/**
 * The pre-1690 client options as a plugin-layer override (Spec 1690 §4.1):
 * `retries` → `retries`, `retryDelay` → `retryBaseDelayMs`, `retryBackoff` →
 * `retryBackoff`, `retryMaxDelay` → `retryMaxDelayMs`, `rateDelayMin`/
 * `rateDelayMax` (seconds) → `minIntervalMs` = min × 1000 and `jitterMs` =
 * (max − min) × 1000, then `crawl` over all of them.
 *
 * The `userAgent` option is NOT part of it: it is a *declared* UA (Spec 1690
 * §4.2), kept by `HttpClient` apart from the configured one — mapping it into the
 * policy would let any plugin put its own UA on the wire under `identify` and
 * even `strict`.
 *
 * A `rateDelayMin` of 0 (or unset) meant "no delay" before Spec 1690 and still
 * does: it leaves the pacing to the layers below instead of forcing 0, and a
 * `rateDelayMax` without a positive `rateDelayMin` is ignored, as it was. Values
 * are validated by the resolver (invalid ones are dropped with a note).
 */
export function crawlOverrideFromClientOptions(options: HttpClientOptions = {}): CrawlPolicyOverride {
  const override: CrawlPolicyOverride = {};
  if (options.retries !== undefined && options.retries !== null) override.retries = options.retries;
  if (options.retryDelay !== undefined && options.retryDelay !== null) override.retryBaseDelayMs = options.retryDelay;
  if (options.retryBackoff !== undefined && options.retryBackoff !== null) override.retryBackoff = options.retryBackoff;
  if (options.retryMaxDelay !== undefined && options.retryMaxDelay !== null) override.retryMaxDelayMs = options.retryMaxDelay;

  const min = options.rateDelayMin;
  const max = options.rateDelayMax;
  if (typeof min === 'number' && Number.isFinite(min) && min > 0) {
    override.minIntervalMs = Math.round(min * 1000);
    if (typeof max === 'number' && Number.isFinite(max) && max > min) override.jitterMs = Math.round((max - min) * 1000);
  }

  if (options.crawl && typeof options.crawl === 'object') {
    for (const [key, value] of Object.entries(options.crawl)) {
      if (value !== undefined) (override as Record<string, unknown>)[key] = value;
    }
  }
  return override;
}

/**
 * True for a `ScraperInputDto` — an instance, or a copy of one (`{ ...input }`
 * keeps the fields its constructor always sets).
 */
export function isScraperInputDto(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value instanceof ScraperInputDto) return true;
  return 'requestTimeout' in value && 'maxConcurrentCompanies' in value && 'descriptionFormat' in value;
}

/** Keys `createHttpClient` copies from whatever object it is given. */
const CLIENT_OPTION_KEYS: readonly (keyof HttpClientOptions)[] = [
  'proxies',
  'caCert',
  'userAgent',
  'retries',
  'retryDelay',
  'retryBackoff',
  'retryMaxDelay',
  'timeout',
  'rateDelayMin',
  'rateDelayMax',
  'cookies',
  'crawl',
  'site',
  'egressAllowHosts',
  'hostLimiter',
  'robotsTxtCache',
  'allowedRedirectHosts',
];

/**
 * `ScraperInputDto` fields that carry what the search caller sent (or what
 * `JobsService` filled in for backward compatibility). Inside a scrape context
 * the context already carries the caller's policy, so these are ignored when a
 * plugin hands the DTO to `createHttpClient` (Spec 1690 §4.1) — otherwise the
 * filled-in retry defaults would override the preset/env, and the caller's
 * `crawl` would bypass `EVER_JOBS_CRAWL_CALLER_OVERRIDES` through the plugin layer.
 */
const DTO_CALLER_FIELDS: readonly (keyof HttpClientOptions)[] = [
  'userAgent',
  'retries',
  'retryDelay',
  'retryBackoff',
  'retryMaxDelay',
  'rateDelayMin',
  'rateDelayMax',
  'crawl',
];

/**
 * Client options from a `ScraperInputDto` (or an object literal shaped like the
 * pre-1690 DTO branch): every known option is kept — including a plugin's own
 * `timeout`, which the pre-1690 branch dropped whenever proxies were set —
 * `requestTimeout` fills `timeout` when the object has none, and inside a scrape
 * context a real DTO's caller fields (`DTO_CALLER_FIELDS`) are ignored.
 */
export function clientOptionsFromScraperInput(source: Record<string, any>): HttpClientOptions {
  const options: HttpClientOptions = {};
  const record = options as Record<string, unknown>;
  for (const key of CLIENT_OPTION_KEYS) {
    if (source[key] !== undefined) record[key] = source[key];
  }
  if (options.timeout === undefined && source.requestTimeout !== undefined) options.timeout = source.requestTimeout;
  if (isScraperInputDto(source) && getScrapeContext() !== undefined) {
    for (const key of DTO_CALLER_FIELDS) delete record[key];
  }
  return options;
}

/** Outcome of `retryDecision`. */
export type RetryDecision = { delayMs: number } | { giveUpAfterMs: number };

/**
 * The computed backoff for retry number `attempt + 1` (Spec 1690 §4.5):
 * `exponential` base × 2^attempt, `linear` base × (attempt + 1), `constant` base;
 * capped at `retryMaxDelayMs`; with `retryJitter`, full jitter (uniform 0..cap).
 */
export function retryBackoffMs(
  policy: Pick<CrawlPolicy, 'retryBackoff' | 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'retryJitter'>,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(0, policy.retryBaseDelayMs);
  const cap = Math.max(0, policy.retryMaxDelayMs);
  let raw: number;
  if (base === 0) raw = 0;
  else if (policy.retryBackoff === 'exponential') raw = base * Math.pow(2, attempt);
  else if (policy.retryBackoff === 'linear') raw = base * (attempt + 1);
  else raw = base;
  const capped = Math.min(Number.isFinite(raw) ? raw : cap, cap);
  if (!policy.retryJitter) return capped;
  return Math.min(capped, Math.floor(random() * (capped + 1)));
}

/** Answers that mean "slow down" (Spec 1690 §4.5). */
const THROTTLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * The back-off floor for retry number `attempt + 1` after a throttling answer
 * (`throttleRetryDelayMs`, Spec 1690 §4.5): `throttleRetryDelayMs × 2^attempt`,
 * capped at `max(retryMaxDelayMs, throttleRetryDelayMs)`. 0 when `status` is not
 * 429/503 (502, 504, network errors keep the plain backoff) or the floor is off
 * (`throttleRetryDelayMs` 0 or absent).
 */
export function throttleRetryFloorMs(
  policy: Pick<CrawlPolicy, 'retryMaxDelayMs'> & Partial<Pick<CrawlPolicy, 'throttleRetryDelayMs'>>,
  attempt: number,
  status: number | undefined,
): number {
  if (status === undefined || !THROTTLE_STATUSES.has(status)) return 0;
  const floor = policy.throttleRetryDelayMs;
  if (typeof floor !== 'number' || !(floor > 0)) return 0;
  const cap = Math.max(policy.retryMaxDelayMs, floor);
  const raw = floor * Math.pow(2, Math.max(0, attempt));
  return Math.min(Number.isFinite(raw) ? raw : cap, cap);
}

/**
 * How long to wait before retry number `attempt + 1`, given the server's
 * `Retry-After` in ms (null = none or `respectRetryAfter` off) and the answer's
 * HTTP `status` (undefined = a network error) — Spec 1690 §4.5:
 *
 * - no Retry-After → the backoff;
 * - `give-up` (default): Retry-After ≤ `maxRetryAfterMs` → `max(backoff,
 *   Retry-After)` (never earlier than asked, even past `retryMaxDelayMs`); over
 *   it → `{ giveUpAfterMs }` (no retry; the bucket cools down that long);
 * - `cap`: Retry-After ≤ `maxRetryAfterMs` → `max(backoff, Retry-After)` (never
 *   earlier than asked); over it → `max(backoff, maxRetryAfterMs)` (wait the
 *   maximum, then retry). The `legacy` preset ties `maxRetryAfterMs` to
 *   `retryMaxDelayMs` (the resolver does it unless a layer sets
 *   `maxRetryAfterMs`), which makes this exactly the pre-1690
 *   `min(retryMaxDelay, max(backoff, Retry-After))`.
 *
 * For a 429/503 "the backoff" above is never less than `throttleRetryFloorMs`
 * (`throttleRetryDelayMs × 2^attempt`): without it a jittered first backoff is
 * 0–1 s, i.e. retrying faster instead of backing off. The give-up decision is
 * unchanged. `throttleRetryDelayMs: 0` (the `legacy` preset) is the arithmetic
 * above exactly.
 */
export function retryDecision(
  policy: Pick<
    CrawlPolicy,
    | 'retryBackoff'
    | 'retryBaseDelayMs'
    | 'retryMaxDelayMs'
    | 'retryJitter'
    | 'respectRetryAfter'
    | 'maxRetryAfterMs'
    | 'retryAfterOverMax'
  > &
    Partial<Pick<CrawlPolicy, 'throttleRetryDelayMs'>>,
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
  status?: number,
): RetryDecision {
  const backoff = Math.max(retryBackoffMs(policy, attempt, random), throttleRetryFloorMs(policy, attempt, status));
  if (!policy.respectRetryAfter || retryAfterMs === null) return { delayMs: backoff };
  const maxRetryAfter = Math.max(0, policy.maxRetryAfterMs);
  if (retryAfterMs <= maxRetryAfter) return { delayMs: Math.max(backoff, retryAfterMs) };
  if (policy.retryAfterOverMax === 'cap') return { delayMs: Math.max(backoff, maxRetryAfter) };
  return { giveUpAfterMs: retryAfterMs };
}

/**
 * Whether a 429/503 backs off the WHOLE bucket (`penalize`, Spec 1690 §4.5): when
 * the bucket is paced at all — a concurrency cap, a minimum interval, the
 * adaptive throttle or a throttle floor (`throttleRetryDelayMs`). A completely
 * unpaced policy (the `legacy` preset) never did, and a `give-up` Retry-After
 * always cools the bucket regardless.
 */
export function penalizesBucket(
  policy: Pick<CrawlPolicy, 'maxConcurrentPerHost' | 'minIntervalMs' | 'adaptiveThrottle'> &
    Partial<Pick<CrawlPolicy, 'throttleRetryDelayMs'>>,
): boolean {
  return (
    policy.maxConcurrentPerHost > 0 ||
    policy.minIntervalMs > 0 ||
    policy.adaptiveThrottle ||
    (policy.throttleRetryDelayMs ?? 0) > 0
  );
}

/**
 * `Retry-After` as milliseconds: delta-seconds or an HTTP-date (relative to
 * `now`). Null when absent or unparseable; an already-past date is 0.
 */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  const text = String(raw).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) return Number(text) * 1000;

  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * True when `err` is a transport failure worth retrying under
 * `retryOnNetworkError`: no HTTP response, not a cancellation, not a crawl-policy
 * refusal, and a connection-level code (`RETRYABLE_NETWORK_CODES`) or a
 * "socket hang up".
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (e.response) return false;
  if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError' || e.name === 'AbortError') return false;
  if (findCrawlPolicyError(err)) return false;
  const code = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : undefined;
  if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return typeof e.message === 'string' && /socket hang up/i.test(e.message);
}

/** The `CrawlPolicyError` behind `err` (itself, or up to five `cause` links down), if any. */
function findCrawlPolicyError(err: unknown): CrawlPolicyError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    if (current instanceof CrawlPolicyError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A header's value, looked up case-insensitively in a plain object or `AxiosHeaders`. */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = (headers as Record<string, unknown>)[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

type MutableHeaders = Record<string, unknown> & { set?: unknown; delete?: unknown };

function removeHeaders(headers: MutableHeaders, matches: (key: string) => boolean): void {
  for (const key of Object.keys(headers)) {
    if (!matches(key)) continue;
    if (typeof headers.delete === 'function') (headers.delete as (k: string) => void).call(headers, key);
    else delete headers[key];
  }
}

function setHeader(headers: MutableHeaders, name: string, value: string): void {
  const wanted = name.toLowerCase();
  removeHeaders(headers, (key) => key.toLowerCase() === wanted);
  if (typeof headers.set === 'function') (headers.set as (k: string, v: string) => void).call(headers, name, value);
  else headers[name] = value;
}

/** The absolute URL axios will request (`baseURL` joined like axios does), or null. */
function resolveTargetUrl(config: AxiosRequestConfig): URL | null {
  const url = typeof config.url === 'string' ? config.url : '';
  const base = typeof config.baseURL === 'string' ? config.baseURL : '';
  const full =
    base && !ABSOLUTE_URL.test(url) ? (url ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : base) : url;
  try {
    return new URL(full);
  } catch {
    return null;
  }
}

/** A forward proxy configured through the environment (axios routes through it itself). */
function envProxyConfigured(): boolean {
  return ENV_PROXY_VARS.some((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/** A native `AbortSignal` that aborts when either does (undefined when neither is given). */
function combineSignals(own: AbortSignal | undefined, context: AbortSignal | undefined): AbortSignal | undefined {
  if (!own) return context;
  if (!context || own === context) return own;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, [own, context]);
  const controller = new AbortController();
  const abort = (source: AbortSignal) => () => controller.abort(abortReasonOf(source));
  if (own.aborted) controller.abort(abortReasonOf(own));
  else if (context.aborted) controller.abort(abortReasonOf(context));
  else {
    own.addEventListener('abort', abort(own), { once: true });
    context.addEventListener('abort', abort(context), { once: true });
  }
  return controller.signal;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | undefined)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * HTTP client with a crawl policy (Spec 1690): honest identity, per-host pacing,
 * configurable proxy rotation, back-off that honours the server, an egress guard
 * and (opt-in) robots.txt — every knob resolved per request from preset, env,
 * builtin host limits, the plugin (manifest + these options), operator policy
 * and the search caller. Replaces Python's RotatingProxySession /
 * RequestsRotating / TLSRotating. `EVER_JOBS_CRAWL_PRESET=legacy` reproduces the
 * pre-1690 wire behaviour.
 */
@Injectable()
export class HttpClient {
  private readonly logger = new Logger(HttpClient.name);
  private readonly client: AxiosInstance;
  /** Proxies this client was given; empty = the scrape context's, else the env's (`getEffectiveProxies`). */
  private readonly proxies: string[];
  private readonly rotation: ProxyRotationState;
  /**
   * The pre-1690 option values, with their pre-1690 defaults — kept for
   * introspection. What goes on the wire follows the resolved crawl policy, into
   * which only the options actually passed feed (`crawlOverrideFromClientOptions`).
   */
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly retryBackoff: 'linear' | 'exponential';
  private readonly retryMaxDelay: number;
  private readonly rateDelayMin: number;
  private readonly rateDelayMax: number;
  private readonly cookieJar?: CookieJar;
  private readonly caCert?: string;
  private readonly site?: string;
  /** Plugin-layer override built from the options (Spec 1690 §4.1). */
  private readonly explicit: CrawlPolicyOverride;
  private readonly hasExplicit: boolean;
  /** UA from the `userAgent` option (a declared UA, Spec 1690 §4.2). */
  private readonly optionUserAgent?: string;
  /** UA declared through `setHeaders()` — captured here, never written into the axios defaults. */
  private declaredUserAgent?: string;
  private readonly egressOptions: EgressGuardOptions;
  private readonly hostLimiterOverride?: HostLimiter;
  private readonly robotsTxtCacheOverride?: RobotsTxtCache;
  /** The instance-default `https.Agent` a `caCert` client gets (not a caller's own agent). */
  private readonly defaultHttpsAgent?: unknown;
  /**
   * The redirect pin (Spec 1689): `redirectPinGuard(allowedRedirectHosts)`, or
   * undefined when the option is unset or `EVER_JOBS_HTTP_PIN_REDIRECTS=false`
   * (read once, when the client is built).
   */
  private readonly redirectPin?: (redirectOptions: Record<string, unknown>) => void;

  constructor(options: HttpClientOptions = {}) {
    const opts: HttpClientOptions = isScraperInputDto(options)
      ? clientOptionsFromScraperInput(options as unknown as Record<string, any>)
      : options ?? {};

    this.proxies = opts.proxies ?? [];
    this.maxRetries = opts.retries ?? 3;
    this.retryDelay = opts.retryDelay ?? 1000;
    this.retryBackoff = opts.retryBackoff ?? 'linear';
    this.retryMaxDelay = opts.retryMaxDelay ?? 30000;
    this.rateDelayMin = (opts.rateDelayMin ?? 0) * 1000; // convert to ms
    this.rateDelayMax = (opts.rateDelayMax ?? 0) * 1000;
    this.caCert = opts.caCert;
    this.site = typeof opts.site === 'string' && opts.site.trim() ? opts.site.trim() : undefined;
    this.explicit = crawlOverrideFromClientOptions(opts);
    this.hasExplicit = Object.keys(this.explicit).length > 0;
    this.optionUserAgent =
      typeof opts.userAgent === 'string' && sanitizeHeaderValue(opts.userAgent) ? sanitizeHeaderValue(opts.userAgent) : undefined;
    this.egressOptions = opts.egressAllowHosts?.length ? { allowHosts: [...opts.egressAllowHosts] } : {};
    this.hostLimiterOverride = opts.hostLimiter;
    this.robotsTxtCacheOverride = opts.robotsTxtCache;
    this.rotation = createProxyRotationState();

    // No User-Agent in the instance defaults: the request interceptor below sets
    // it on every request (Spec 1690 §4.2). Top-level defaults used to beat
    // `setHeaders()`, silently discarding every UA a plugin declared.
    // Accept self-signed certs if caCert is configured. `transportFor` swaps this
    // default for the guarded insecure agent whenever the egress guard is on, so
    // a call through `getAxiosInstance()` is DNS-guarded too.
    this.defaultHttpsAgent = opts.caCert ? new (require('https').Agent)({ rejectUnauthorized: false }) : undefined;
    this.redirectPin =
      opts.allowedRedirectHosts?.length && redirectPinningEnabled()
        ? redirectPinGuard(opts.allowedRedirectHosts)
        : undefined;
    this.client = axios.create({
      timeout: (opts.timeout ?? 60) * 1000,
      ...(this.defaultHttpsAgent ? { httpsAgent: this.defaultHttpsAgent } : {}),
      // Spec 1689: the instance default, so a call straight through
      // `getAxiosInstance()` is pinned too. A per-request `beforeRedirect`
      // replaces it in axios' merge, so the request interceptor composes it
      // back in (`transportFor`, or directly when the egress guard is off).
      ...(this.redirectPin ? { beforeRedirect: this.redirectPin } : {}),
    });
    this.client.interceptors.request.use((config) => this.applyCrawlIdentity(config));

    if (opts.cookies) {
      this.cookieJar = opts.cookies === true ? new CookieJar() : opts.cookies;
      this.attachCookieInterceptors();
    }
  }

  private attachCookieInterceptors(): void {
    if (!this.cookieJar) return;

    this.client.interceptors.request.use(async (config) => {
      this.applyRequestCookies(config);
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        this.storeResponseCookies(response);
        return response;
      },
      (error) => {
        if (error.response) {
          this.storeResponseCookies(error.response);
        }
        return Promise.reject(error);
      },
    );
  }

  private applyRequestCookies(config: AxiosRequestConfig): void {
    if (!this.cookieJar || !config.url) return;

    const cookieString = this.cookieJar.getCookieStringSync(config.url);
    if (!cookieString) return;

    const headers = config.headers ?? (config.headers = {});
    if (
      typeof (headers as { get?: unknown }).get === 'function' &&
      typeof (headers as { set?: unknown }).set === 'function'
    ) {
      const axiosHeaders = headers as { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
      const existing = axiosHeaders.get('Cookie') ?? '';
      axiosHeaders.set('Cookie', existing ? `${existing}; ${cookieString}` : cookieString);
    } else {
      const existing = (headers as Record<string, unknown>)['Cookie'] ?? '';
      (headers as Record<string, string>)['Cookie'] = existing
        ? `${existing}; ${cookieString}`
        : cookieString;
    }
  }

  private storeResponseCookies(response: AxiosResponse): void {
    if (!this.cookieJar) return;

    const setCookie = response.headers?.['set-cookie'];
    if (!setCookie) return;

    const url = response.config?.url;
    if (!url) return;

    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookies) {
      try {
        this.cookieJar.setCookieSync(cookie, url);
      } catch (err) {
        this.logger.debug(`Ignoring malformed Set-Cookie: ${err}`);
      }
    }
  }

  /**
   * The agent for `proxy`. With `lookup` (the egress guard on an untrusted
   * proxy), the connection to the proxy itself resolves through it, so a proxy
   * host that resolves to a private address is refused.
   */
  private createAgent(proxy: string, lookup?: ReturnType<typeof createGuardedLookup>): HttpsProxyAgent<string> | SocksProxyAgent {
    if (proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) {
      return lookup
        ? new SocksProxyAgent(proxy, { socketOptions: { lookup } as unknown as NonNullable<ConstructorParameters<typeof SocksProxyAgent>[1]>['socketOptions'] })
        : new SocksProxyAgent(proxy);
    }
    const proxyUrl = proxy.startsWith('http') ? proxy : `http://${proxy}`;
    return lookup
      ? new HttpsProxyAgent(proxyUrl, { lookup } as unknown as ConstructorParameters<typeof HttpsProxyAgent>[1])
      : new HttpsProxyAgent(proxyUrl);
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  /**
   * Send a request under the crawl policy resolved for its host (Spec 1690):
   * egress guard → robots.txt (opt-in) → for every attempt a slot from the
   * host limiter → retries with back-off / `Retry-After` → whole-bucket back-off
   * on 429/503. A `crawl` key on the config (`CrawlRequestConfig`) overrides the
   * policy for this one request.
   */
  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const { crawl: requestCrawl, ...axiosConfig } = config as CrawlRequestConfig;
    const ctx = getScrapeContext();
    const target = resolveTargetUrl(axiosConfig);
    const policy = this.resolvePolicy(target?.hostname, ctx, requestCrawl);
    const site = ctx?.site ?? this.site;
    const bucket = target ? bucketKeyFor(target.href, policy.rateLimitScope, site) : undefined;
    // The caller's own signal and the scrape's deadline signal both cancel the
    // request (queued, sleeping between retries, or in flight). A non-native
    // caller signal (axios' GenericAbortSignal) still goes to axios as-is.
    const ownSignal = axiosConfig.signal;
    const nativeOwn = typeof AbortSignal !== 'undefined' && ownSignal instanceof AbortSignal ? ownSignal : undefined;
    const signal = combineSignals(nativeOwn, ctx?.signal);
    const axiosSignal = ownSignal && !nativeOwn ? ownSignal : signal;
    const identity = this.identityFor(policy, headerValue(axiosConfig.headers, 'user-agent'), ctx, requestCrawl);

    if (target && policy.blockPrivateNetworks) assertPublicHostname(target.hostname, this.egressOptions);

    // Chosen once per request, so retries reuse it (as before Spec 1690).
    const proxy = selectProxy(getEffectiveProxies(this.proxies), policy.proxyRotation, this.rotation, bucket ?? '');
    const transport = this.transportFor(proxy, policy, axiosConfig, target);
    const limiter = this.hostLimiter;

    let crawlDelayMs = 0;
    if (target && policy.robotsTxt !== 'off') {
      const fetcher: RobotsFetcher = (robotsUrl) =>
        this.fetchRobotsTxt(robotsUrl, policy, site, transport, signal, axiosSignal);
      const decision = await this.robotsTxtCache.check(target.href, identity.userAgent, policy.robotsTxt, fetcher);
      if (!decision.allowed) throw new RobotsDisallowedError(this.redactUrl(target.href));
      // A site's Crawl-delay is honoured up to the limiter's cool-down ceiling.
      crawlDelayMs = Math.min(decision.crawlDelayMs ?? 0, limiter.maxCooldownMs);
    }

    const limits = this.acquireOptions(policy, signal, crawlDelayMs);
    const retries = Math.max(0, Math.floor(policy.retries));

    for (let attempt = 0; ; attempt++) {
      const release = bucket ? await limiter.acquire(bucket, limits) : undefined;
      let error: unknown;
      try {
        const response = await this.client.request<T>({
          ...axiosConfig,
          ...transport,
          ...(axiosSignal ? { signal: axiosSignal } : {}),
          [IDENTITY_KEY]: identity,
        } as AxiosRequestConfig);
        if (bucket) this.recordResponse(bucket, policy, attempt, response, axiosConfig);
        return response;
      } catch (err) {
        error = err;
      } finally {
        release?.();
      }

      const refusal = findCrawlPolicyError(error);
      if (refusal) throw refusal;
      if (signal?.aborted || (axiosSignal as { aborted?: boolean } | undefined)?.aborted) throw error;

      const status = statusOf(error);
      const throttled = status === 429 || status === 503;
      if (bucket) limiter.recordOutcome(bucket, throttled ? 'throttled' : status !== undefined && status < 500 ? 'ok' : 'error');

      const retryable =
        status !== undefined ? policy.retryStatuses.includes(status) : policy.retryOnNetworkError && isRetryableNetworkError(error);
      const retryAfter =
        status !== undefined && policy.respectRetryAfter
          ? this.retryAfterMs((error as { response?: { headers?: unknown } }).response?.headers)
          : null;
      // A 429/503 gets the throttle floor (`throttleRetryDelayMs`) under its wait.
      const decision = retryDecision(policy, attempt, retryAfter, undefined, status);
      const willRetry = retryable && attempt < retries;

      if ('giveUpAfterMs' in decision) {
        // A Retry-After on an answer we would neither retry nor call throttling
        // (e.g. a 404) is not a back-off request.
        if (!retryable && !throttled) throw error;
        // The server asked for longer than we wait: never retry early, and hold
        // every request of the bucket for the full Retry-After (up to the
        // limiter's `maxCooldownMs`).
        if (bucket) limiter.penalize(bucket, decision.giveUpAfterMs);
        if (!willRetry) throw error;
        this.logger.warn(
          `${this.describeRequest(axiosConfig)} failed ${status}, Retry-After ${decision.giveUpAfterMs}ms exceeds ` +
            `maxRetryAfterMs ${policy.maxRetryAfterMs}ms; not retrying (${bucket ?? 'no bucket'} cooling down)`,
        );
        const coolingDown = new HostCoolingDownError(bucket ?? target?.host ?? '(unknown host)', decision.giveUpAfterMs, status);
        Object.defineProperty(coolingDown, 'cause', { value: error, enumerable: false, configurable: true, writable: true });
        throw coolingDown;
      }

      const delay = decision.delayMs;
      // Any 429/503 backs off the whole bucket, not just this request — whenever
      // the bucket is paced at all (`penalizesBucket`; the unpaced `legacy`
      // preset never did) — for at least the throttle floor.
      if (throttled && bucket && penalizesBucket(policy)) limiter.penalize(bucket, delay);
      if (!willRetry) throw error;

      const what = status ?? (error as { code?: unknown })?.code ?? 'network error';
      this.logger.warn(
        `${this.describeRequest(axiosConfig)} failed ${what}, retry ${attempt + 1}/${retries} in ${delay}ms` +
          (bucket ? ` (${bucket})` : ''),
      );
      await this.sleep(delay, signal);
    }
  }

  /** Update default headers for this client instance */
  setHeaders(headers: Record<string, string>): void {
    const rest: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (key.toLowerCase() === 'user-agent') {
        // A declared UA (Spec 1690 §4.2): the interceptor decides whether it goes out.
        this.declaredUserAgent = typeof value === 'string' && value.trim() ? value : undefined;
      } else {
        rest[key] = value;
      }
    }
    Object.assign(this.client.defaults.headers.common, rest);
  }

  /** Get the underlying Axios instance for low-level access */
  getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  /**
   * The crawl policy a request to `url` would be sent under right now (scrape
   * context in scope, this client's options), with provenance. Diagnostics.
   */
  crawlPolicyFor(url: string, override?: CrawlPolicyOverride): ResolvedCrawlPolicy {
    const target = resolveTargetUrl({ url });
    return this.resolvePolicy(target?.hostname ?? url, getScrapeContext(), override);
  }

  // ── crawl policy ────────────────────────────────────────────────────────────

  /**
   * Limiter options for one attempt. With no `maxQueueWaitMs`, a request still
   * never waits out a bucket cool-down longer than `maxRetryAfterMs` — the most
   * it would ever wait for the server itself — and fails fast with
   * `HostCoolingDownError` instead (Spec 1690 §4.5).
   */
  private acquireOptions(
    policy: CrawlPolicy,
    signal: AbortSignal | undefined,
    crawlDelayMs = 0,
  ): HostLimiterAcquireOptions & HostLimiterAcquireExtraOptions {
    return {
      maxConcurrent: policy.maxConcurrentPerHost,
      minIntervalMs: Math.max(policy.minIntervalMs, crawlDelayMs),
      jitterMs: policy.jitterMs,
      maxWaitMs: policy.maxQueueWaitMs,
      adaptive: policy.adaptiveThrottle,
      maxCoolDownWaitMs: policy.maxQueueWaitMs > 0 ? 0 : Math.max(1, policy.maxRetryAfterMs),
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * Feed a response the caller accepted (e.g. `validateStatus: () => true`) to
   * the limiter: a 429/503 still counts as throttling and backs off the bucket
   * (the Retry-After, or the backoff — never less than the throttle floor
   * `throttleRetryDelayMs` — under the give-up/cap rules; Spec 1690 §4.5) — it is
   * just not retried, since the caller asked to see the status. Anything else is
   * an `ok` outcome.
   */
  private recordResponse(
    bucket: string,
    policy: CrawlPolicy,
    attempt: number,
    response: AxiosResponse,
    config: AxiosRequestConfig,
  ): void {
    const limiter = this.hostLimiter;
    const status = response?.status;
    if (status !== 429 && status !== 503) {
      limiter.recordOutcome(bucket, 'ok');
      return;
    }
    limiter.recordOutcome(bucket, 'throttled');
    const retryAfter = policy.respectRetryAfter ? this.retryAfterMs(response.headers) : null;
    const decision = retryDecision(policy, attempt, retryAfter, undefined, status);
    if ('giveUpAfterMs' in decision) {
      limiter.penalize(bucket, decision.giveUpAfterMs);
      this.logger.warn(
        `${this.describeRequest(config)} answered ${status}, Retry-After ${decision.giveUpAfterMs}ms exceeds ` +
          `maxRetryAfterMs ${policy.maxRetryAfterMs}ms (${bucket} cooling down)`,
      );
    } else if (penalizesBucket(policy)) {
      limiter.penalize(bucket, decision.delayMs);
      this.logger.debug(`${this.describeRequest(config)} answered ${status}; ${bucket} backs off ${decision.delayMs}ms`);
    }
  }

  private get hostLimiter(): HostLimiter {
    return this.hostLimiterOverride ?? getHostLimiter();
  }

  private get robotsTxtCache(): RobotsTxtCache {
    return this.robotsTxtCacheOverride ?? getRobotsTxtCache();
  }

  private resolvePolicy(
    hostname: string | undefined,
    ctx: ScrapeContext | undefined,
    requestCrawl?: CrawlPolicyOverride,
  ): ResolvedCrawlPolicy {
    const explicit =
      requestCrawl && typeof requestCrawl === 'object'
        ? { ...this.explicit, ...requestCrawl }
        : this.hasExplicit
          ? this.explicit
          : undefined;
    const resolve = () => getEffectiveCrawlPolicy(hostname, explicit);
    return this.site && !ctx?.site ? runWithScrapeContext({ site: this.site }, resolve) : resolve();
  }

  private identityFor(
    policy: ResolvedCrawlPolicy,
    perRequest: string | undefined,
    ctx: ScrapeContext | undefined,
    requestCrawl?: CrawlPolicyOverride,
  ): WireIdentity {
    const env = readCrawlPolicyEnv();
    const manifest = ctx?.plugin && crawlPluginManifestsEnabled(env) ? ctx.plugin : undefined;
    const choice = selectWireUserAgent({
      policy,
      perRequest,
      setHeaders: this.declaredUserAgent,
      // The declared UA below `setHeaders()`: the per-request `crawl.userAgent`,
      // the `userAgent` option, the client's `crawl.userAgent`, then the manifest's
      // — every plugin-layer UA is a declaration, never the configured UA.
      option:
        this.declaredCrawlUserAgent(requestCrawl?.userAgent, env) ??
        this.optionUserAgent ??
        this.declaredCrawlUserAgent(this.explicit.userAgent, env) ??
        this.declaredCrawlUserAgent(manifest?.userAgent, env),
      pluginOptIn:
        manifest?.userAgentMode === 'plugin' ||
        this.explicit.userAgentMode === 'plugin' ||
        requestCrawl?.userAgentMode === 'plugin',
      legacy:
        policy.userAgentMode === 'strict' && policy.provenance.userAgentMode === 'preset' && env.preset === 'legacy',
    });
    const identity: WireIdentity = {
      userAgent: choice.userAgent,
      stripClientHints: choice.source === 'configured' && policy.stripClientHints,
    };
    if (policy.from) identity.from = policy.from;
    return identity;
  }

  /** A `crawl.userAgent` a plugin declared: header-safe, keywords (`browser`, `default`…) expanded. */
  private declaredCrawlUserAgent(value: unknown, env: { contact?: string }): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = sanitizeHeaderValue(value);
    return clean ? expandUserAgent(clean, env.contact) : undefined;
  }

  /**
   * The request interceptor (Spec 1690 §4.2) — the only point that beats
   * per-request headers in axios' merge order. Applies the identity `request()`
   * computed; a call made straight through `getAxiosInstance()` resolves its own
   * (and is egress-checked here, but not paced — it bypasses `request()`).
   */
  private applyCrawlIdentity(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    const record = config as unknown as Record<string, unknown>;
    let identity = record[IDENTITY_KEY] as WireIdentity | undefined;
    delete record[IDENTITY_KEY];
    if (!config.headers) config.headers = {} as InternalAxiosRequestConfig['headers'];
    const headers = config.headers as unknown as MutableHeaders;

    if (!identity) {
      const ctx = getScrapeContext();
      const target = resolveTargetUrl(config);
      const policy = this.resolvePolicy(target?.hostname, ctx);
      if (target && policy.blockPrivateNetworks) {
        assertPublicHostname(target.hostname, this.egressOptions);
        Object.assign(config, this.transportFor(null, policy, config, target));
      } else if (this.redirectPin && config.beforeRedirect && config.beforeRedirect !== this.redirectPin) {
        // Egress guard off: no egress check or agent swap, but the request's own
        // `beforeRedirect` replaced the instance-default pin in axios' merge, so
        // compose the pin back in — it runs first, the request's hook after it.
        const pin = this.redirectPin;
        const own = config.beforeRedirect;
        config.beforeRedirect = ((...args: Parameters<typeof own>) => {
          pin(args[0]);
          own(...args);
        }) as typeof own;
      }
      identity = this.identityFor(policy, headerValue(headers, 'user-agent'), ctx);
    }

    setHeader(headers, 'User-Agent', identity.userAgent);
    if (identity.stripClientHints) removeHeaders(headers, (key) => CLIENT_HINT_HEADER.test(key));
    if (identity.from) setHeader(headers, 'From', identity.from);
    return config;
  }

  /**
   * Agents and redirect guard for one request (Spec 1690 §4.4/§4.8):
   * - through a proxy: the proxy agent (as before); only the literal checks
   *   apply to the target. A proxy that is not one of the operator's env proxies
   *   (`EVER_JOBS_CRAWL_PROXIES` / `DEFAULT_PROXIES`) — e.g. a search caller's —
   *   is itself egress-checked: literally, and through a guarded DNS lookup;
   * - direct with `blockPrivateNetworks`: shared keep-alive agents whose DNS
   *   lookup refuses private answers (unless the request brings its own agents,
   *   an axios `proxy`, or an `HTTP(S)_PROXY` that applies to this URL — a URL
   *   `NO_PROXY` exempts goes direct, so it is guarded). A `caCert` client's
   *   instance-default agent is not "its own": it becomes the guarded insecure one.
   *   A target on the client's `egressAllowHosts` gets the unguarded shared agents;
   * - `blockPrivateNetworks: false`: nothing — the pre-1690 agents.
   * With `blockPrivateNetworks`, every redirect target is checked too (a literal
   * IP never reaches the DNS lookup). With `allowedRedirectHosts` (Spec 1689),
   * every hop is also pinned to those hosts — first, before the egress check,
   * and whatever `blockPrivateNetworks` says; a `beforeRedirect` the request
   * brought itself runs last, so it can neither replace nor skip either guard.
   */
  private transportFor(
    proxy: string | null,
    policy: CrawlPolicy,
    config: AxiosRequestConfig,
    target?: URL | null,
  ): Partial<AxiosRequestConfig> {
    const transport: Partial<AxiosRequestConfig> = {};
    if (proxy) {
      let lookup: ReturnType<typeof createGuardedLookup> | undefined;
      if (policy.blockPrivateNetworks && !readCrawlPolicyEnv().proxies.includes(proxy)) {
        assertPublicProxy(proxy, this.egressOptions);
        lookup = createGuardedLookup(undefined, this.egressOptions);
      }
      const agent = this.createAgent(proxy, lookup);
      transport.httpAgent = agent;
      transport.httpsAgent = agent;
    }
    const pin = this.redirectPin;
    if (!policy.blockPrivateNetworks && !pin) return transport;

    if (policy.blockPrivateNetworks) {
      const ownHttpsAgent = config.httpsAgent !== undefined && config.httpsAgent !== this.defaultHttpsAgent;
      if (!proxy && !config.httpAgent && !ownHttpsAgent && !config.proxy && this.goesDirect(target)) {
        const allowListed =
          !!target && !!this.egressOptions.allowHosts?.length && isEgressAllowListed(target.hostname, this.egressOptions);
        const agents = getGuardedAgents({ insecureTls: Boolean(this.caCert), guard: !allowListed });
        transport.httpAgent = agents.httpAgent;
        transport.httpsAgent = agents.httpsAgent;
      }
    }

    // `config.beforeRedirect` is the pin itself when axios merged the instance
    // default in (a direct `getAxiosInstance()` call) — run it once, not twice.
    const previous = config.beforeRedirect === pin ? undefined : config.beforeRedirect;
    const allow = policy.blockPrivateNetworks ? this.egressOptions : undefined;
    type BeforeRedirect = NonNullable<AxiosRequestConfig['beforeRedirect']>;
    transport.beforeRedirect = ((...args: Parameters<BeforeRedirect>) => {
      const [options] = args;
      pin?.(options);
      if (allow) {
        let host = '';
        if (typeof options.href === 'string') {
          try {
            host = new URL(options.href).hostname;
          } catch {
            host = '';
          }
        }
        if (!host) host = typeof options.hostname === 'string' ? options.hostname : String(options.host ?? '');
        assertPublicHostname(host, allow);
      }
      previous?.(...args);
    }) as BeforeRedirect;
    return transport;
  }

  /**
   * Whether axios connects straight to `target` (no `HTTP(S)_PROXY` applies to it,
   * or `NO_PROXY` exempts it). Unknown (no URL, or axios' resolver unavailable)
   * with an env proxy set = not direct, as before.
   */
  private goesDirect(target: URL | null | undefined): boolean {
    if (!envProxyConfigured()) return true;
    if (!target) return false;
    return envProxyFor(target.href) === '';
  }

  /**
   * robots.txt fetcher (Spec 1690 §4.7): straight through the axios instance
   * (not `request()`, so no robots recursion), with the configured UA, a slot
   * from the limiter, and the request's proxy / agents / redirect guard / signal.
   */
  private async fetchRobotsTxt(
    robotsUrl: string,
    policy: ResolvedCrawlPolicy,
    site: string | undefined,
    transport: Partial<AxiosRequestConfig>,
    signal: AbortSignal | undefined,
    axiosSignal: AxiosRequestConfig['signal'],
  ): Promise<{ status: number; body: string } | null> {
    const bucket = bucketKeyFor(robotsUrl, policy.rateLimitScope, site);
    const release = await this.hostLimiter.acquire(bucket, this.acquireOptions(policy, signal));
    try {
      const identity: WireIdentity = { userAgent: policy.userAgent, stripClientHints: policy.stripClientHints };
      if (policy.from) identity.from = policy.from;
      const response = await this.client.request({
        url: robotsUrl,
        method: 'GET',
        headers: { Accept: 'text/plain, */*;q=0.5' },
        responseType: 'text',
        maxContentLength: ROBOTS_MAX_DOWNLOAD_BYTES,
        validateStatus: () => true,
        ...transport,
        ...(axiosSignal ? { signal: axiosSignal } : {}),
        [IDENTITY_KEY]: identity,
      } as AxiosRequestConfig);
      const body = typeof response.data === 'string' ? response.data : response.data == null ? '' : String(response.data);
      this.logger.debug(`robots.txt ${robotsUrl} → ${response.status}`);
      return { status: response.status, body };
    } finally {
      release();
    }
  }

  /**
   * Identify the request a log line is about. Scrapers fan out concurrently, so a
   * message without its own target cannot be attributed to anything.
   */
  private describeRequest(config: AxiosRequestConfig): string {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ? this.redactUrl(config.url) : '(no url)';
    const requestId = getRequestId();
    return requestId ? `[${requestId}] ${method} ${url}` : `${method} ${url}`;
  }

  /**
   * Strip credentials out of a URL before it reaches a log line, leaving the
   * rest intact so the message still names its target. Splits on delimiters
   * rather than parsing, so a relative or malformed URL degrades to "unchanged"
   * instead of throwing inside a logging path.
   */
  private redactUrl(url: string): string {
    return this.redactQuery(this.redactPathCredential(url));
  }

  /**
   * Replace a credential carried as a path segment (see
   * `SENSITIVE_PATH_SEGMENTS`) with `REDACTED`. Relative URLs and hosts with no
   * rule are returned unchanged.
   */
  private redactPathCredential(url: string): string {
    const authority = URL_AUTHORITY.exec(url);
    if (!authority) return url;

    const host = authority[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
    const index = SENSITIVE_PATH_SEGMENTS[host];
    if (index === undefined) return url;

    const pathStart = authority[0].length;
    const query = url.indexOf('?', pathStart);
    const fragment = url.indexOf('#', pathStart);
    const ends = [query, fragment].filter((i) => i !== -1);
    const pathEnd = ends.length ? Math.min(...ends) : url.length;

    // A path that starts with `/` splits to a leading empty segment, so the
    // first real segment is at index 1.
    const segments = url.slice(pathStart, pathEnd).split('/');
    const target = index + 1;
    if (target >= segments.length || !segments[target]) return url;

    segments[target] = 'REDACTED';
    return url.slice(0, pathStart) + segments.join('/') + url.slice(pathEnd);
  }

  /**
   * Replace the value of every credential-bearing query parameter with
   * `REDACTED`.
   */
  private redactQuery(url: string): string {
    const start = url.indexOf('?');
    if (start === -1) return url;

    const [query, ...fragment] = url.slice(start + 1).split('#');
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const key = pair.slice(0, eq);
        return SENSITIVE_QUERY_KEYS.test(key) ? `${key}=REDACTED` : pair;
      })
      .join('&');

    const hash = fragment.length ? `#${fragment.join('#')}` : '';
    return `${url.slice(0, start)}?${redacted}${hash}`;
  }

  /** `Retry-After` as milliseconds: delta-seconds or an HTTP-date. Null when absent/unparseable. */
  private retryAfterMs(headers: unknown): number | null {
    return parseRetryAfter(headerValue(headers, 'retry-after'));
  }

  /** Wait `ms` (clamped to what `setTimeout` honours); rejects with the signal's reason if it aborts first. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReasonOf(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReasonOf(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.min(MAX_TIMER_MS, Math.max(0, ms)));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Factory to create HttpClient instances with options.
 */
/**
 * Factory to create HttpClient instances with options.
 * Can accept either HttpClientOptions or ScraperInputDto.
 *
 * An object with `requestTimeout` or `proxies` takes the DTO branch
 * (`clientOptionsFromScraperInput`): a plugin's own `timeout` survives it, and
 * inside a scrape context a real DTO's retry/rate/UA/crawl fields are ignored —
 * the context already carries the caller's policy (Spec 1690 §4.1). Outside any
 * context they apply as the plugin/explicit layer, as before.
 */
export function createHttpClient(options?: HttpClientOptions | any): HttpClient {
  if (options && (options.requestTimeout !== undefined || options.proxies !== undefined)) {
    // It's likely a ScraperInputDto or a similar object from a scraper
    // `allowedRedirectHosts` (Spec 1689) is one of the `CLIENT_OPTION_KEYS` it copies.
    return new HttpClient(clientOptionsFromScraperInput(options));
  }
  return new HttpClient(options as HttpClientOptions);
}
