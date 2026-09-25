/**
 * Constants for the Workstream hourly-hiring ATS platform.
 *
 * Workstream (workstream.us) is an all-in-one HR, payroll, and hiring platform
 * built for the hourly/deskless workforce — restaurants, retail, hospitality, and
 * healthcare.  Every employer is assigned a short opaque account UUID (eight hex
 * characters, e.g. `36047dd7`) and a brand slug (e.g. `jamba`). Public careers
 * pages are served from:
 *
 *   https://www.workstream.us/j/{accountId}/{brandSlug}
 *
 * Additional URL aliases in the wild:
 *   - `https://got.work/{brandSlug}`          → 301 → `jobs.workstream.us/j/{brandSlug}` → 301 → the canonical URL above
 *   - `https://www.workstream.us/j/{companyIdentifier}-careers-open-positions`
 *     (older franchise-style URLs used by some enterprise accounts)
 *
 * ## Public Wire Surface (heuristic — live HTML, no anonymous JSON API found)
 *
 * The Workstream platform serves its public careers pages as server-rendered HTML
 * at two levels:
 *
 *   1. **Positions list page** (all open roles for a tenant):
 *        GET https://www.workstream.us/j/{accountId}/{brandSlug}/positions
 *        → HTML page containing `<a href="/j/{accountId}/{brandSlug}/{locationSlug}/{jobSlug}-{jobId}">` links
 *          Each link anchor contains the job title, location address, employment type,
 *          brief description snippet, and pay rate.
 *
 *   2. **Individual job detail page**:
 *        GET https://www.workstream.us/j/{accountId}/{brandSlug}/{locationSlug}/{jobSlug}-{jobId}?locale=en
 *        → HTML page containing the full job description, requirements, company name,
 *          precise location (address, city, state, ZIP, country), apply URL.
 *
 * ### URL segment anatomy
 *
 *   `{accountId}`   — 8-character hex UUID that identifies the Workstream account,
 *                     e.g. `36047dd7`.
 *   `{brandSlug}`   — URL-safe brand/company label, e.g. `jamba`, `ymca`, `ihop`.
 *   `{locationSlug}`— City slug + numeric location id, e.g. `san-jose-5497`.
 *   `{jobSlug}`     — Hyphenated job title, e.g. `general-manager`.
 *   `{jobId}`       — 8-character hex job identifier, e.g. `68051091`.
 *                     This serves as the stable ATS id.
 *
 * The `companySlug` caller input is expected to be `{accountId}/{brandSlug}`
 * (e.g. `36047dd7/jamba`), or alternatively a full `companyUrl` whose path
 * begins with `/j/{accountId}/{brandSlug}`.
 *
 * ### Authentication
 *
 * The public careers HTML is served anonymously (no auth required). The
 * Workstream REST API (`public-api.workstream.us/positions`) requires OAuth2
 * bearer tokens — it is deliberately NOT used here; we rely entirely on the
 * public HTML careers surface.
 *
 * ### Unknown / dead tenants
 *
 * An invalid or unknown `{accountId}/{brandSlug}` path returns HTTP 404 or an
 * HTML "Record does not exist." page. Both are caught and degrade to empty
 * results without throwing.
 *
 * ### Apply URL
 *
 * Each job detail page exposes a canonical apply URL at:
 *   `.../j/{accountId}/{brandSlug}/{locationSlug}/{jobSlug}-{jobId}/apply?locale=en`
 * which is constructed from the job URL.
 *
 * ### Pagination
 *
 * The `/positions` listing page renders all open positions for the tenant in a
 * single HTML response (no server-side paging). We parse all job links at once
 * and then fan out to individual detail pages for rich data (full description,
 * structured location), bounded by `resultsWanted` and `WORKSTREAM_MAX_CONCURRENCY`.
 *
 * Investigation performed 2026-06-03.
 * Tenants confirmed live: `36047dd7/jamba` (Jamba franchise), `f030c4f0/ymca`,
 * `221e9529/ihop`, `3547b62e/wendys`.
 */

/** Canonical public host for all Workstream tenant careers pages. */
export const WORKSTREAM_HOST = 'https://www.workstream.us';

/** Path to the tenant positions listing page (`{companyPath}` substituted at runtime). */
export const WORKSTREAM_POSITIONS_PATH_TEMPLATE = '/j/{companyPath}/positions';

/** Path template for a single job detail page. */
export const WORKSTREAM_JOB_PATH_TEMPLATE = '/j/{companyPath}/{locationSlug}/{jobSlug}-{jobId}';

/** Locale query param appended to all job-detail fetches. */
export const WORKSTREAM_LOCALE_PARAM = 'locale=en';

/**
 * Maximum number of job-detail pages to fetch concurrently in a single fan-out
 * batch. Kept conservative to stay polite to the public HTML server.
 */
export const WORKSTREAM_MAX_CONCURRENCY = 5;

/** Delay range (ms) between sequential fan-out rounds, to stay polite. */
export const WORKSTREAM_REQUEST_DELAY_MS = 300;

/**
 * Default internal results cap — when `resultsWanted` is not specified, ingest
 * up to this many open positions. The public DTO default is 15; we raise it
 * internally for bulk runs.
 */
export const WORKSTREAM_DEFAULT_RESULTS = 100;

/** Default request headers — a browser-like UA to avoid bot-rejection on the HTML tier. */
export const WORKSTREAM_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Regex that matches a Workstream job URL path segment in the positions listing
 * HTML.  Captures groups:
 *   1 — {locationSlug}  (e.g. `san-jose-5497`)
 *   2 — {jobSlug}       (e.g. `general-manager`)
 *   3 — {jobId}         (8-char hex, e.g. `68051091`)
 *
 * Full path example:
 *   /j/36047dd7/jamba/san-jose-5497/general-manager-68051091
 */
export const WORKSTREAM_JOB_HREF_REGEX =
  /\/j\/[0-9a-f_-]+\/[^/]+\/([a-z0-9-]+)\/([a-z0-9-]+)-([0-9a-f]{8})/;

/**
 * Env toggle for Workstream's country inference (Spec 1689), layered on top of
 * the shared parser: a US address shape ("San Jose, CA 95130") fills a missing
 * country with `US` — the stamp Spec 5125 removed. `false` / `0` / `off` /
 * `no` → shared-parser output only (literal-only country); unset or anything
 * else → inference on.
 */
export const WORKSTREAM_LOCATION_HEURISTICS_ENV = 'WORKSTREAM_LOCATION_HEURISTICS';

export function workstreamLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[WORKSTREAM_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
