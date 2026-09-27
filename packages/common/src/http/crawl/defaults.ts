import { CrawlPolicy, CrawlPolicyOverride, CrawlPreset } from './types';

/** Product token used in the default UA and for robots.txt group matching. */
export const EVER_JOBS_UA_PRODUCT = 'EverJobs';

/** Bumped when the crawler's observable behaviour changes materially. */
export const EVER_JOBS_UA_VERSION = '1.0';

/** Where a site operator can read who we are and how to reach us. */
export const EVER_JOBS_UA_INFO_URL = 'https://github.com/ever-jobs/ever-jobs';

/**
 * The honest default User-Agent, in the de-facto crawler convention
 * (`Mozilla/5.0 (compatible; <Bot>/<ver>; +<url>)`, as Googlebot and bingbot do):
 * it names the project, links to it, and does not claim to be a browser.
 */
export const EVER_JOBS_DEFAULT_USER_AGENT =
  `Mozilla/5.0 (compatible; ${EVER_JOBS_UA_PRODUCT}/${EVER_JOBS_UA_VERSION}; +${EVER_JOBS_UA_INFO_URL})`;

/**
 * The exact UA `HttpClient` sent by default before Spec 1690. Kept so the old
 * behaviour stays one setting away (`EVER_JOBS_CRAWL_USER_AGENT=browser`, or the
 * `legacy` preset).
 */
export const LEGACY_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Keywords accepted wherever a UA string is configured. */
export const USER_AGENT_KEYWORDS: Record<string, string> = {
  default: EVER_JOBS_DEFAULT_USER_AGENT,
  everjobs: EVER_JOBS_DEFAULT_USER_AGENT,
  browser: LEGACY_BROWSER_USER_AGENT,
  legacy: LEGACY_BROWSER_USER_AGENT,
};

/**
 * `polite` — the built-in default. Honest identity, a stable origin per site,
 * bounded concurrency per host, and back-off that honours the server.
 *
 * Sized so a default search stays inside its 120 s deadline: bulk ATS APIs that
 * serve hundreds of company plugins get their own higher limits in
 * `BUILTIN_HOST_POLICIES`; everything else is capped at 4 in flight and at most
 * 10 request starts per second per host.
 */
export const POLITE_CRAWL_POLICY: CrawlPolicy = {
  userAgent: EVER_JOBS_DEFAULT_USER_AGENT,
  userAgentMode: 'identify',
  stripClientHints: true,

  proxyRotation: 'per-host',

  rateLimitScope: 'host',
  maxConcurrentPerHost: 4,
  minIntervalMs: 100,
  jitterMs: 0,
  maxQueueWaitMs: 0,
  adaptiveThrottle: true,
  // Spec 1714: no idle gap and no server-error cool-down by default (the pre-1714
  // behaviour); EVER_JOBS_CRAWL_MIN_GAP_MS / _SERVER_ERROR_COOLDOWN_MS turn them on.
  minGapMs: 0,
  serverErrorCooldownMs: 0,

  retries: 2,
  retryStatuses: [429, 502, 503, 504],
  retryBackoff: 'exponential',
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
  retryJitter: true,
  retryOnNetworkError: false,
  respectRetryAfter: true,
  maxRetryAfterMs: 60000,
  retryAfterOverMax: 'give-up',
  // A 429/503 without Retry-After waits ≥ 5 s, then ≥ 10 s — not the 0–1 s of a
  // jittered first backoff (retrying faster instead of backing off).
  throttleRetryDelayMs: 5000,

  robotsTxt: 'off',
  blockPrivateNetworks: true,
  discovery: 'auto',
};

/**
 * `legacy` — byte-for-byte the pre-1690 behaviour: browser UA, per-request proxy
 * rotation, no pacing, 3 linear retries on 429/5xx with `Retry-After` capped at
 * 30 s, no egress guard.
 */
export const LEGACY_CRAWL_POLICY: CrawlPolicy = {
  userAgent: LEGACY_BROWSER_USER_AGENT,
  userAgentMode: 'strict',
  stripClientHints: false,

  proxyRotation: 'per-request',

  rateLimitScope: 'host',
  maxConcurrentPerHost: 0,
  minIntervalMs: 0,
  jitterMs: 0,
  maxQueueWaitMs: 0,
  adaptiveThrottle: false,
  minGapMs: 0,
  serverErrorCooldownMs: 0,

  retries: 3,
  retryStatuses: [429, 500, 502, 503, 504],
  retryBackoff: 'linear',
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
  retryJitter: false,
  retryOnNetworkError: false,
  respectRetryAfter: true,
  maxRetryAfterMs: 30000,
  retryAfterOverMax: 'cap',
  throttleRetryDelayMs: 0,

  robotsTxt: 'off',
  blockPrivateNetworks: false,
  discovery: 'auto',
};

/**
 * `strict` — the most conservative crawler: honest UA everywhere, one request at
 * a time per registrable domain, one per second, robots.txt obeyed, and at least
 * 30 s of back-off after a 429/503.
 */
export const STRICT_CRAWL_POLICY: CrawlPolicy = {
  ...POLITE_CRAWL_POLICY,
  userAgentMode: 'strict',
  proxyRotation: 'per-host',
  rateLimitScope: 'domain',
  maxConcurrentPerHost: 1,
  minIntervalMs: 1000,
  jitterMs: 250,
  retries: 1,
  retryStatuses: [429, 503],
  throttleRetryDelayMs: 30000,
  robotsTxt: 'respect',
};

export const CRAWL_PRESETS: Record<CrawlPreset, CrawlPolicy> = {
  polite: POLITE_CRAWL_POLICY,
  legacy: LEGACY_CRAWL_POLICY,
  strict: STRICT_CRAWL_POLICY,
};

/**
 * The pace the operator of the Softy ATS asked for (`*.softy.pro`: ONE shared
 * server for every client tenant) — Spec 1714 FR-8. One request at a time per
 * registrable domain, at least 1 s between starts and 0.5 s of idle time after
 * each answer, one stable proxy, one retry on 429/503 only, at least 10 s of
 * back-off after a throttle and 30 s after a server error, `Retry-After` always
 * honoured — and a caller lock (`callerOverrides: 'stricter'`) so an API caller
 * can only make this traffic MORE polite.
 *
 * It applies to EVERY request to those hosts, whichever site makes it (the Softy
 * plugin, liveness probes, the JSON-LD plugin…), because the builtin-host layer
 * is resolved per request host. It must agree with the Softy manifest
 * (`SOFTY_CRAWL_POLICY`, Spec 1715) on every pacing / retry / lock field; a parity
 * test in the Softy suite guards that. No identity field on purpose (spec D6): a
 * builtin `userAgentMode` could loosen an operator's env `strict`.
 *
 * Operator `sites` / `hosts` entries still override it, including the lock:
 * `{"hosts":{"*.softy.pro":{"callerOverrides":"any"},"softy.pro":{"callerOverrides":"any"}}}`.
 * `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` switches the whole builtin layer off.
 */
export const BUILTIN_SOFTY_HOST_POLICY: CrawlPolicyOverride = {
  rateLimitScope: 'domain',
  maxConcurrentPerHost: 1,
  minIntervalMs: 1000,
  minGapMs: 500,
  proxyRotation: 'per-host',
  retries: 1,
  retryStatuses: [429, 503],
  throttleRetryDelayMs: 10000,
  serverErrorCooldownMs: 30000,
  respectRetryAfter: true,
  retryAfterOverMax: 'give-up',
  callerOverrides: 'stricter',
};

/**
 * Builtin host policies (layer 3), keyed by host pattern with the operator `hosts`
 * semantics (Spec 1714 FR-8): an exact host, or `*.suffix` for any subdomain (not
 * the apex). Every matching pattern applies, least specific first, so the most
 * specific one wins field by field. `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (the
 * `legacy` preset's default) switches the layer off; operator `sites` / `hosts`
 * entries override any of them.
 *
 * - Hosts that serve hundreds of company plugins through one public, CDN-backed
 *   API. A default search sends ~800 requests to Greenhouse alone, so the generic
 *   per-host cap would push most of them past the search deadline. These limits
 *   still bound bursts.
 * - Site-owner policies: `*.softy.pro` and the apex `softy.pro`
 *   (`BUILTIN_SOFTY_HOST_POLICY`).
 */
export const BUILTIN_HOST_POLICIES: Record<string, CrawlPolicyOverride> = {
  'api.greenhouse.io': { maxConcurrentPerHost: 16, minIntervalMs: 0 },
  'boards-api.greenhouse.io': { maxConcurrentPerHost: 16, minIntervalMs: 0 },
  'api.lever.co': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
  'api.ashbyhq.com': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
  'api.smartrecruiters.com': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
  '*.softy.pro': BUILTIN_SOFTY_HOST_POLICY,
  'softy.pro': BUILTIN_SOFTY_HOST_POLICY,
};

/**
 * Environment variable names (single source of truth for docs and tests).
 */
export const CRAWL_ENV = {
  PRESET: 'EVER_JOBS_CRAWL_PRESET',
  USER_AGENT: 'EVER_JOBS_CRAWL_USER_AGENT',
  USER_AGENT_MODE: 'EVER_JOBS_CRAWL_USER_AGENT_MODE',
  CONTACT: 'EVER_JOBS_CRAWL_CONTACT',
  FROM: 'EVER_JOBS_CRAWL_FROM',
  STRIP_CLIENT_HINTS: 'EVER_JOBS_CRAWL_STRIP_CLIENT_HINTS',
  PROXY_ROTATION: 'EVER_JOBS_CRAWL_PROXY_ROTATION',
  PROXIES: 'EVER_JOBS_CRAWL_PROXIES',
  LEGACY_PROXIES: 'DEFAULT_PROXIES',
  RATE_SCOPE: 'EVER_JOBS_CRAWL_RATE_SCOPE',
  MAX_CONCURRENT_PER_HOST: 'EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST',
  MIN_INTERVAL_MS: 'EVER_JOBS_CRAWL_MIN_INTERVAL_MS',
  JITTER_MS: 'EVER_JOBS_CRAWL_JITTER_MS',
  MAX_QUEUE_WAIT_MS: 'EVER_JOBS_CRAWL_MAX_QUEUE_WAIT_MS',
  ADAPTIVE: 'EVER_JOBS_CRAWL_ADAPTIVE',
  /** `minGapMs` (Spec 1714 FR-9). Default 0 = no idle gap, the pre-1714 behaviour. */
  MIN_GAP_MS: 'EVER_JOBS_CRAWL_MIN_GAP_MS',
  /** `serverErrorCooldownMs` (Spec 1714 FR-10). Default 0 = no cool-down, the pre-1714 behaviour. */
  SERVER_ERROR_COOLDOWN_MS: 'EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS',
  RETRIES: 'EVER_JOBS_CRAWL_RETRIES',
  RETRY_STATUSES: 'EVER_JOBS_CRAWL_RETRY_STATUSES',
  RETRY_BACKOFF: 'EVER_JOBS_CRAWL_RETRY_BACKOFF',
  RETRY_BASE_DELAY_MS: 'EVER_JOBS_CRAWL_RETRY_BASE_DELAY_MS',
  RETRY_MAX_DELAY_MS: 'EVER_JOBS_CRAWL_RETRY_MAX_DELAY_MS',
  RETRY_JITTER: 'EVER_JOBS_CRAWL_RETRY_JITTER',
  RETRY_ON_NETWORK_ERROR: 'EVER_JOBS_CRAWL_RETRY_ON_NETWORK_ERROR',
  RESPECT_RETRY_AFTER: 'EVER_JOBS_CRAWL_RESPECT_RETRY_AFTER',
  MAX_RETRY_AFTER_MS: 'EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS',
  RETRY_AFTER_OVER_MAX: 'EVER_JOBS_CRAWL_RETRY_AFTER_OVER_MAX',
  THROTTLE_RETRY_DELAY_MS: 'EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS',
  ROBOTS_TXT: 'EVER_JOBS_CRAWL_ROBOTS_TXT',
  BLOCK_PRIVATE_NETWORKS: 'EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS',
  DISCOVERY: 'EVER_JOBS_CRAWL_DISCOVERY',
  POLICIES: 'EVER_JOBS_CRAWL_POLICIES',
  POLICY_FILE: 'EVER_JOBS_CRAWL_POLICY_FILE',
  CALLER_OVERRIDES: 'EVER_JOBS_CRAWL_CALLER_OVERRIDES',
  ABORT_ON_DEADLINE: 'EVER_JOBS_CRAWL_ABORT_ON_DEADLINE',
} as const;
