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

  robotsTxt: 'off',
  blockPrivateNetworks: false,
  discovery: 'auto',
};

/**
 * `strict` — the most conservative crawler: honest UA everywhere, one request at
 * a time per registrable domain, one per second, robots.txt obeyed.
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
  robotsTxt: 'respect',
};

export const CRAWL_PRESETS: Record<CrawlPreset, CrawlPolicy> = {
  polite: POLITE_CRAWL_POLICY,
  legacy: LEGACY_CRAWL_POLICY,
  strict: STRICT_CRAWL_POLICY,
};

/**
 * Hosts that serve hundreds of company plugins through one public, CDN-backed
 * API. A default search sends ~800 requests to Greenhouse alone, so the generic
 * per-host cap would push most of them past the search deadline. These limits
 * still bound bursts; operators can override any of them per host.
 */
export const BUILTIN_HOST_POLICIES: Record<string, CrawlPolicyOverride> = {
  'api.greenhouse.io': { maxConcurrentPerHost: 16, minIntervalMs: 0 },
  'boards-api.greenhouse.io': { maxConcurrentPerHost: 16, minIntervalMs: 0 },
  'api.lever.co': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
  'api.ashbyhq.com': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
  'api.smartrecruiters.com': { maxConcurrentPerHost: 12, minIntervalMs: 0 },
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
  ROBOTS_TXT: 'EVER_JOBS_CRAWL_ROBOTS_TXT',
  BLOCK_PRIVATE_NETWORKS: 'EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS',
  DISCOVERY: 'EVER_JOBS_CRAWL_DISCOVERY',
  POLICIES: 'EVER_JOBS_CRAWL_POLICIES',
  POLICY_FILE: 'EVER_JOBS_CRAWL_POLICY_FILE',
  CALLER_OVERRIDES: 'EVER_JOBS_CRAWL_CALLER_OVERRIDES',
  ABORT_ON_DEADLINE: 'EVER_JOBS_CRAWL_ABORT_ON_DEADLINE',
} as const;
