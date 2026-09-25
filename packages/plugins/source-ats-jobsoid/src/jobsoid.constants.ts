/**
 * Constants for the Jobsoid recruitment ATS platform.
 *
 * Jobsoid (jobsoid.com) is a cloud-based applicant tracking and recruitment
 * platform. Every customer tenant gets a public, branded careers portal served
 * from its own sub-domain under the shared apex `jobsoid.com`
 * (e.g. `https://simpler.jobsoid.com/`). The tenant label is the first
 * sub-domain segment (the `companySlug`).
 *
 * Each careers portal exposes a **public, anonymous JSON jobs feed** at:
 *
 *   GET https://{tenant}.jobsoid.com/api/v1/jobs
 *     → HTTP 200, `application/json`
 *     → a flat JSON array of full job objects (NOT paginated, NOT wrapped)
 *
 * The list endpoint embeds the FULL job record inline — including the HTML
 * `description`, structured `location`, `applyUrl`, and `hostedUrl` — so NO
 * per-job detail fan-out is required. A single GET yields everything.
 *
 * A single job can also be fetched at:
 *
 *   GET https://{tenant}.jobsoid.com/api/v1/jobs/{id}
 *     → HTTP 200, the same object shape as one array element.
 *
 * Unknown tenants resolve (DNS wildcard) and the API returns an empty array
 * `[]` with HTTP 200 — so an unknown tenant degrades to zero jobs without any
 * error. Tenants with no open roles likewise return `[]`.
 *
 * The endpoint does not honour `offset` / `limit` query parameters (observed:
 * `?limit=1` still returned the full set), so the result-set is sliced
 * client-side to `resultsWanted`. De-dup is by the numeric `id` within a run.
 *
 * The public job-detail page (the `hostedUrl` returned by the API) follows the
 * pattern: `https://{tenant}.jobsoid.com/j/{id}/{slug}`, and the apply page is
 * `https://{tenant}.jobsoid.com/apply/{id}`.
 *
 * Verified live on 2026-06-03:
 *   - `GET https://simpler.jobsoid.com/api/v1/jobs` → HTTP 200, 3 full job
 *     objects with inline HTML `description`, `location{city,state,country}`,
 *     `function.title`, `postedDate`, `hostedUrl`, `applyUrl`, `slug`,
 *     `company`.
 *   - `GET https://simpler.jobsoid.com/api/v1/jobs/91392` → HTTP 200, single
 *     job object (same shape).
 *   - `GET https://<unknown-tenant>.jobsoid.com/api/v1/jobs` → HTTP 200, `[]`.
 */

/** Shared apex for every Jobsoid-hosted tenant sub-domain. */
export const JOBSOID_APEX = 'jobsoid.com';

/** Host template for Jobsoid-hosted tenants; `{tenant}` is substituted at runtime. */
export const JOBSOID_HOST_TEMPLATE = 'https://{tenant}.jobsoid.com';

/** Path to the public, anonymous JSON jobs feed (appended to the tenant host). */
export const JOBSOID_JOBS_PATH = '/api/v1/jobs';

/** Public job-detail (hosted) page template; `{tenant}`, `{id}`, `{slug}` substituted. */
export const JOBSOID_JOB_PAGE_TEMPLATE = 'https://{tenant}.jobsoid.com/j/{id}/{slug}';

/** Public apply page template; `{tenant}` and `{id}` substituted. */
export const JOBSOID_APPLY_PAGE_TEMPLATE = 'https://{tenant}.jobsoid.com/apply/{id}';

/**
 * Default internal results cap. The public DTO default is lower, but when a
 * caller omits `resultsWanted` entirely we ingest up to this many of the
 * tenant's open roles.
 */
export const JOBSOID_DEFAULT_RESULTS = 100;

/**
 * Default request headers sent with every feed fetch. The Jobsoid public API
 * accepts plain JSON with no special headers; a browser-like UA is polite.
 */
export const JOBSOID_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Env toggle for Jobsoid location heuristics (Spec 1689), layered on top of
 * the shared parser: a free-text "City - State" label ("Pune - Maharashtra",
 * "Milan - Milan") keeps its region as the state — the pre-5125 behaviour; the
 * shared parser keeps only the city and drops the region. `false` / `0` /
 * `off` / `no` → shared-parser output only; unset or anything else → on.
 */
export const JOBSOID_LOCATION_HEURISTICS_ENV = 'JOBSOID_LOCATION_HEURISTICS';

export function jobsoidLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[JOBSOID_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
