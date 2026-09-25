import type { PluginCrawlPolicy } from '@ever-jobs/common';

/** SimplyHired search URL */
export const SIMPLYHIRED_SEARCH_URL = 'https://www.simplyhired.com/search';

/** Default delay between page requests (ms) */
export const SIMPLYHIRED_DELAY_MIN = 2000;
export const SIMPLYHIRED_DELAY_MAX = 5000;

/** Default headers for SimplyHired requests */
export const SIMPLYHIRED_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * Crawl-policy opt-in (Spec 1690 §4.2): keep the plugin's declared browser UA
 * under the default `identify` mode. Evidence, not assumption: a live A/B on
 * 2026-09-25 got HTTP 403 on the search page and on all 21 detail pages with the
 * Ever Jobs UA, and 200 on all 22 requests with the declared UA. Operators can
 * still force the honest UA with EVER_JOBS_CRAWL_USER_AGENT_MODE=strict.
 */
export const SIMPLYHIRED_CRAWL_POLICY: PluginCrawlPolicy = {
  userAgentMode: 'plugin',
  userAgentReason:
    'simplyhired.com answers HTTP 403 to search and job-detail pages requested with the Ever Jobs User-Agent (live A/B 2026-09-25: 22/22 requests 200 with the declared browser UA, 403 with the honest UA).',
};
