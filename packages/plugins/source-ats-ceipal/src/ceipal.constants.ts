/**
 * Constants for the Ceipal staffing / talent-acquisition platform.
 *
 * Ceipal (ceipal.com) is a US-based cloud ATS + workforce-management platform
 * used primarily by staffing firms, MSPs, and corporate recruiting teams. Each
 * customer tenant can publish a branded **public career portal**. The reference
 * client for that portal is a small jQuery app served by Ceipal itself from
 * `https://api.ceipal.com/careers_v3/js/app.min.js`; tenants host a thin
 * `index.html` + `includes/config.inc.js` shell on their own marketing domain
 * (e.g. `https://joblist.smartdata.net/`, `https://avcend.com/careers/`).
 *
 * The portal config declares exactly two values:
 *
 *   const api_key = '…';                 // the tenant's public career-portal key
 *   const api_url = 'https://api.ceipal.com/';
 *
 * From those, the reference client derives an anonymous (no-auth) API base and
 * a family of REST resources — the key itself is the only tenant identifier and
 * is carried **in the URL path**, never in a header:
 *
 *   ajax_url            = api_url + api_key + '/'   // https://api.ceipal.com/{apiKey}/
 *   job_postings_url    = ajax_url + 'job-postings/'
 *   countries_list_url  = ajax_url + 'countries-list/'
 *   states_list_url     = ajax_url + 'states/'
 *   industries_list_url = ajax_url + 'industries-list/'
 *
 * Job listing (anonymous):
 *   GET https://api.ceipal.com/{apiKey}/job-postings/?page={n}[&<filter>]
 *     → Django-REST paginated envelope:
 *       { status: 1, success: 1, count, num_pages, page_number,
 *         next, previous, results: CeipalJobPosting[] }
 *     The `#job_postings_filter` form is serialised onto the query string and
 *     `&page=` is appended; an empty filter (page only) returns the full list.
 *
 * Job detail (anonymous):
 *   GET https://api.ceipal.com/{apiKey}/job-postings/{job_id}/
 *     → { status: 1, success: 1, ...CeipalJobDetail }  (adds the full HTML
 *       `public_job_desc` / `requistion_description`, required documents, etc.)
 *
 * The listing rows already carry a short HTML description
 * (`requistion_description` / `public_job_desc`), so a per-job detail fetch is
 * only used to enrich the description when the caller wants richer HTML and the
 * list row omitted it. Detail fetches fan out with a bounded
 * `Promise.allSettled` and tolerate individual failures.
 *
 * Error / unknown-tenant behaviour (verified live 2026-06-03):
 *   - An unknown / rotated key on a known resource path returns HTTP 400 with
 *     `{ status: 400, success: 0, message: "The provided API Key is not
 *     matched, please contact you administrator and get back." }`.
 *   - A non-existent resource path returns a plain HTTP 404 HTML page.
 *   Both degrade to an empty result rather than throwing.
 *
 * Verification (2026-06-03):
 *   - Reference client confirmed live at
 *     `https://api.ceipal.com/careers_v3/js/app.min.js` (HTTP 200) — endpoint
 *     URL family, the `api_url + api_key + '/'` construction, the
 *     `job-postings/` + `job-postings/{id}/` resources, the DRF pagination
 *     envelope (`results` / `num_pages` / `page_number` / `next` / `previous`),
 *     and the per-job field names below were all extracted from it byte-for-byte.
 *   - Route family confirmed live: `GET https://api.ceipal.com/{key}/
 *     countries-list/` returns the documented key-validation envelope above,
 *     proving the `{apiKey}/{resource}/` routing is active server-side.
 *   - Sampled tenant keys (smartdata, avcend, troy-consulting) were observed to
 *     be rotated / migrated at verification time, so a live HTTP 200 job body
 *     could not be captured. The per-job field mapping below is therefore taken
 *     from the official reference client (the exact fields it reads off each
 *     `results[i]`), and the service layers defensive fallbacks accordingly.
 */

/** Base URL for the Ceipal public career-portal API (production). */
export const CEIPAL_API_BASE = 'https://api.ceipal.com/';

/** Public host that serves the reference career-portal client bundle. */
export const CEIPAL_API_HOST = 'api.ceipal.com';

/**
 * Resource path (relative to `{base}{apiKey}/`) for the anonymous job listing.
 * Full URL: `https://api.ceipal.com/{apiKey}/job-postings/`.
 */
export const CEIPAL_JOB_POSTINGS_PATH = 'job-postings/';

/**
 * Query parameter name for 1-based listing pagination. The reference client
 * appends `&page={n}` to the serialised filter form.
 */
export const CEIPAL_PAGE_PARAM = 'page';

/** Server-side page size assumption used to plan pagination rounds. */
export const CEIPAL_PAGE_SIZE = 20;

/** Maximum number of detail-fetch calls issued concurrently per round. */
export const CEIPAL_MAX_CONCURRENCY = 5;

/** Delay (ms) between sequential pagination rounds, to stay polite. */
export const CEIPAL_REQUEST_DELAY_MS = 250;

/** Hard ceiling on listing pages walked per run (defence against huge tenants). */
export const CEIPAL_MAX_PAGES = 25;

/**
 * Default internal results cap. When `resultsWanted` is omitted we ingest up to
 * this many of the tenant's open roles.
 */
export const CEIPAL_DEFAULT_RESULTS = 100;

/**
 * The API detail resource for an individual role (`{key}` and `{id}` are
 * substituted at runtime). 🛑 It serves JSON, not a page (Spec 1751): the
 * reference portal routes job detail through a hash fragment on the tenant's
 * own portal, which a bare key does not name. `buildJobUrl` uses it only when
 * no public page (`apply_job`, the caller's portal, a syndication link) is known.
 */
export const CEIPAL_JOB_PAGE_TEMPLATE =
  'https://api.ceipal.com/{key}/job-postings/{id}/';

/**
 * Default request headers. The career-portal API accepts anonymous JSON GETs;
 * a browser-like Accept and User-Agent are polite and avoid naive bot gates.
 */
export const CEIPAL_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
