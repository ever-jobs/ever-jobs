/**
 * Spec 5036 — AppOne constants.
 *
 * AppOne (a Paychex-owned recruiting product, distinct from
 * `source-ats-paychex`'s `applybypaychex.com` sitemap + JSON-LD surface)
 * serves an Angular SPA backed by two unauthenticated JSON REST endpoints:
 *
 *   - list:   `GET https://jobs.appone.com/api/portal/v1/companyjobposts/{tenant}`
 *             → `{ companyName, clientId, jobPosts: [...] }`. Carries every
 *             comparable field except the body: title, location, jobType,
 *             workplaceType, datePosted, jobPostUrl.
 *   - detail: `GET https://apply.appone.com/api/apply/v2/jobposting/{jobPostId}`
 *             → adds `description` (the full plain-text body).
 *
 * The tenant is the last path segment of a `jobs.appone.com/{tenant}` careers
 * URL (e.g. `vansaircraftcareers`).
 */

/** Careers-portal host — serves the company job-post list API. */
export const APPONE_LIST_BASE_URL = 'https://jobs.appone.com';

/** Apply host — serves the per-posting detail API and canonical job URLs. */
export const APPONE_APPLY_BASE_URL = 'https://apply.appone.com';

/** List endpoint: all postings for a tenant (`{tenant}` = careers-URL slug). */
export const apponeListEndpoint = (tenant: string): string =>
  `${APPONE_LIST_BASE_URL}/api/portal/v1/companyjobposts/${encodeURIComponent(tenant)}`;

/** Detail endpoint: a single posting by `jobPostId` (carries the body). */
export const apponeDetailEndpoint = (jobPostId: string): string =>
  `${APPONE_APPLY_BASE_URL}/api/apply/v2/jobposting/${encodeURIComponent(jobPostId)}`;

/** Default `resultsWanted` cap when the caller doesn't supply one. */
export const APPONE_DEFAULT_RESULTS_WANTED = 100;

/** Max parallel detail fetches per tenant (bounded concurrency for the overlay). */
export const APPONE_DETAIL_CONCURRENCY = 6;

/** Headers AppOne's JSON API expects (plain JSON GET, no auth). */
export const APPONE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: APPONE_LIST_BASE_URL,
  Referer: `${APPONE_LIST_BASE_URL}/`,
};
