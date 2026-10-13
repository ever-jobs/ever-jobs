/**
 * Constants for the ClearCompany applicant-tracking careers platform.
 *
 * ClearCompany hosts the public careers sites of its customers under one shared
 * host, `https://careers-page.clearcompany.com`, with each tenant addressed by
 * a short slug in the page path (`/jobs/{slug}`). The public, unauthenticated
 * job feed lives behind a single REST endpoint:
 *
 *   GET https://careers-page.clearcompany.com/api/v1/careers/jobs
 *       header `API-ShortName: {slug}`
 *     → JobPosting[]  (a flat JSON array of the tenant's open positions)
 *
 * The tenant is resolved entirely from the `API-ShortName` header (the careers
 * slug); there is no path/query tenant param. The endpoint returns the full
 * open-roles list in one response (no server-side pagination), so we slice
 * client-side to honour `resultsWanted`. An unknown slug yields a `400` with
 * `{"Message":"Unknown or missing API-ShortName header value."}`, which we treat
 * as an empty (graceful) result rather than an error.
 */

/** Shared public host for every ClearCompany-hosted careers site. */
export const CLEARCOMPANY_HOST = 'https://careers-page.clearcompany.com';

/** Public, unauthenticated jobs feed path (tenant via the `API-ShortName` header). */
export const CLEARCOMPANY_JOBS_PATH = '/api/v1/careers/jobs';

/** Public job-board / job-detail page path template (`{slug}`, `{id}` substituted). */
export const CLEARCOMPANY_JOB_PAGE_TEMPLATE = '/jobs/{slug}/{id}';

/** Header the careers API uses to identify the tenant by its careers slug. */
export const CLEARCOMPANY_SHORTNAME_HEADER = 'API-ShortName';

/**
 * Newer careers-API host. Each embedded careers widget / portal site is
 * addressable by a GUID "site id" and serves its own richer feed:
 *
 *   GET https://careers-api.clearcompany.com/v1/{siteId}
 *     → { results: [...], totalCount, currentPageIndex, currentPageCount }
 *
 * This is the feed the tenant's embedded widget renders; the legacy
 * careers-page feed can under-report relative to it (postings published only
 * to the widget portal are absent from the API-ShortName feed — observed
 * 127 vs 158 on a live tenant).
 */
export const CLEARCOMPANY_CAREERS_API_HOST = 'https://careers-api.clearcompany.com';

/** GUID shape: a GUID-valued companySlug / siteNumber is a site id, not a slug. */
export const CLEARCOMPANY_SITE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default internal results cap. Mirrors the Eightfold adapter: the public DTO
 * default is 15, but when a caller omits `resultsWanted` entirely we ingest up
 * to 100 of the tenant's open roles.
 */
export const CLEARCOMPANY_DEFAULT_RESULTS = 100;

/** Default request headers. ClearCompany expects a browser-like UA + JSON accept. */
export const CLEARCOMPANY_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
