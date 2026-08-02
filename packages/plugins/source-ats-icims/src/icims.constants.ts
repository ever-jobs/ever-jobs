/**
 * iCIMS candidate-experience boards are server-rendered HTML.
 *
 * Every tenant lives on a subdomain of `icims.com` (the slug is usually
 * `careers-{company}`). The listings page is reachable directly — without a
 * browser — by requesting the board in its embeddable ("iframe") form:
 *
 *   https://{subdomain}.icims.com/jobs/search?ss=1&in_iframe=1&pr={page}
 *
 * `in_iframe=1` returns the inner iCIMS board even when the tenant wraps it in
 * a custom career site, so the same request shape works for every tenant.
 * `pr` is a **0-based page index** (not a record offset); each page holds up to
 * `ICIMS_PAGE_SIZE` job cards and the board reports "Page X of N".
 */

/** iCIMS tenant host suffix. */
export const ICIMS_ROOT_DOMAIN = '.icims.com';

/** Job cards per board page. */
export const ICIMS_PAGE_SIZE = 20;

/** Default cap on jobs returned when the caller does not specify one. */
export const ICIMS_DEFAULT_RESULTS = 1000;

/** Safety cap on pages walked, independent of resultsWanted. */
export const ICIMS_MAX_PAGES = 500;

/** Default headers for iCIMS board requests. */
export const ICIMS_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
};

/** Matches "remote" as a whole word (location text or title). */
export const ICIMS_REMOTE_REGEX = /\bremote\b/i;

/** Pulls the total page count out of a board's "Page X of N" pager. */
export const ICIMS_PAGE_OF_REGEX = /Page\s+\d+\s+of\s+(\d+)/i;

/** Pulls the company display name out of "Job Listings at {Company}". */
export const ICIMS_TITLE_COMPANY_REGEX = /Job Listings at\s+(.+?)\s*$/i;

/** Numeric job id embedded in a `/jobs/{id}/{slug}/job` board URL. */
export const ICIMS_JOB_ID_REGEX = /\/jobs\/(\d+)\//;

/**
 * Build a board listings URL for a tenant subdomain + 0-based page index.
 */
export function buildIcimsBoardUrl(subdomain: string, page: number): string {
  const params = new URLSearchParams();
  params.set('ss', '1');
  params.set('in_iframe', '1');
  if (page > 0) params.set('pr', String(page));
  return `https://${subdomain}${ICIMS_ROOT_DOMAIN}/jobs/search?${params.toString()}`;
}
