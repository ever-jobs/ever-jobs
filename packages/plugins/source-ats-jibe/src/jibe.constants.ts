/**
 * Jibe (the iCIMS Talent Cloud candidate-experience platform) careers sites are
 * client-rendered SPAs: the listings page is a JS shell and the jobs live behind
 * a same-origin JSON API the SPA calls itself:
 *
 *   https://{host}/api/jobs?page={n}
 *
 * Tenants are whole domains (careers.rivian.com) or a mount path on a corporate
 * domain ({host}/{mount}/jobs); the API always sits at the ORIGIN root. Pages are
 * a fixed 10 jobs — `pageSize` is ignored — and the envelope reports `totalCount`.
 * A tenant's apply links usually point at its real ATS (e.g. `*.icims.com`).
 */

/** Same-origin API the Jibe SPA lists jobs from. */
export const JIBE_API_PATH = '/api/jobs';

/** Jobs per API page — server-fixed; a `pageSize` param is ignored. */
export const JIBE_PAGE_SIZE = 10;

/** Default cap on jobs returned when the caller does not specify one. */
export const JIBE_DEFAULT_RESULTS = 1000;

/** Safety cap on pages walked, independent of resultsWanted. */
export const JIBE_MAX_PAGES = 400;

/** Default headers for Jibe API requests. */
export const JIBE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
};

/** Matches "remote" as a whole word (location text or title). */
export const JIBE_REMOTE_REGEX = /\bremote\b/i;

/** `location_type` values that mean the job is remote. */
export const JIBE_REMOTE_LOCATION_TYPES = new Set(['TELECOMMUTE', 'REMOTE', 'HOME', 'WORK_FROM_HOME']);

/** Path segment the SPA's job detail pages live under, relative to the site mount. */
export const JIBE_JOBS_SEGMENT = 'jobs';

/**
 * Build the listings API URL for a Jibe site origin + 1-based page index.
 */
export function buildJibeApiUrl(origin: string, page: number): string {
  return `${origin}${JIBE_API_PATH}?page=${page}`;
}

/**
 * Build a job detail URL for a site mount base + job slug, e.g.
 * `https://careers.rivian.com/careers-home/jobs/33835`.
 */
export function buildJibeJobUrl(detailBase: string, slug: string): string {
  return `${detailBase}/${JIBE_JOBS_SEGMENT}/${slug}`;
}
