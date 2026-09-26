import type { PluginCrawlPolicy } from '@ever-jobs/common';

export const USAJOBS_API_URL = 'https://data.usajobs.gov/api/Search';

export const USAJOBS_HEADERS: Record<string, string> = {
  Host: 'data.usajobs.gov',
  Accept: 'application/json',
};

/**
 * Maximum results per page allowed by the USAJobs API.
 */
export const USAJOBS_MAX_PAGE_SIZE = 500;

/**
 * Default number of results to request.
 */
export const USAJOBS_DEFAULT_RESULTS = 25;

/**
 * Crawl-policy defaults for USAJobs (Spec 1690), declared in `@SourcePlugin({ crawl })`.
 *
 * The Search API documents that the `User-Agent` header must be the e-mail address
 * registered with the API key (sent alongside `Authorization-Key`). The plugin
 * declares that e-mail through `setHeaders`; this opt-in lets it reach the wire under
 * the default `identify` mode. Operators can still override it per site
 * (`EVER_JOBS_CRAWL_POLICIES` `sites.usajobs.userAgentMode`), and
 * `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` (or the `legacy` preset) ignores it — the
 * configured UA then goes out and the API may refuse the request.
 */
export const USAJOBS_CRAWL_POLICY: PluginCrawlPolicy = {
  userAgentMode: 'plugin',
  userAgentReason:
    'The USAJobs Search API requires the User-Agent header to be the e-mail address registered with the API key (developer.usajobs.gov).',
};
