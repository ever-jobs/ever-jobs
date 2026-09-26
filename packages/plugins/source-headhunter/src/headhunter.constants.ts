import type { PluginCrawlPolicy } from '@ever-jobs/common';

export const HEADHUNTER_API_URL = 'https://api.hh.ru/vacancies';
export const HEADHUNTER_DEFAULT_RESULTS = 25;
export const HEADHUNTER_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'ever-jobs/0.1.0 (job-aggregator)',
};

/**
 * Crawl-policy defaults for HeadHunter (Spec 1690), declared in `@SourcePlugin({ crawl })`.
 *
 * The hh.ru API requires every request to identify the calling *application* in its
 * `User-Agent` (`AppName/Version (contact)`; `HH-User-Agent` as a fallback) and
 * answers a missing or blacklisted one with `400 bad_user_agent`. The plugin
 * declares its app UA (`HEADHUNTER_HEADERS`) through `setHeaders`; this opt-in lets it
 * reach the wire under the default `identify` mode. Operators can replace it per site
 * (`EVER_JOBS_CRAWL_POLICIES` `sites.headhunter: { userAgentMode: 'strict',
 * userAgent: 'MyApp/1.0 (ops@example.com)' }`), and
 * `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` (or the `legacy` preset) ignores it.
 */
export const HEADHUNTER_CRAWL_POLICY: PluginCrawlPolicy = {
  userAgentMode: 'plugin',
  userAgentReason:
    'The hh.ru API requires an application-identifying User-Agent (AppName/Version) and answers a missing or blacklisted one with 400 bad_user_agent (api.hh.ru docs).',
};
