/**
 * Constants for the CATS (catsone.com) hosted recruiting ATS.
 *
 * CATS powers public career portals for staffing agencies, recruiters, and
 * direct employers. Every customer tenant is served from its own sub-domain
 * under the shared apex `catsone.com`
 * (e.g. `https://authoritypartnersinc.catsone.com`). Some tenants may also
 * front their portal with a custom domain.
 *
 * ## Public surface
 *
 * CATS career portals serve fully server-rendered HTML; there is **no
 * anonymous public JSON feed**. The authenticated API
 * (`GET https://api.catsone.com/v3/portals/{id}/jobs` with an
 * `Authorization: Token <key>` header) requires a per-tenant secret key
 * and is deliberately NOT used in this adapter.
 *
 * The portal HTML layout is well-structured with stable CSS class names
 * documented in the CATS Job Widget developer guide:
 *
 *   - Tenant main careers page: `https://{slug}.catsone.com/careers/`
 *     Lists all portals configured for the tenant. Each portal entry is an
 *     anchor whose `href` matches the pattern `/careers/{portalID}-{name}`.
 *   - Portal listing page: `https://{slug}.catsone.com/careers/{portalID}-{name}`
 *     Contains a table or list of open positions; each row is wrapped in a
 *     `.cats-job` element with `.cats-job-title`, `.cats-job-location`, and
 *     `.cats-job-category` children. The `href` on the `.cats-job-title`
 *     anchor follows `/careers/{portalID}-{name}/jobs/{jobID}-{slug}`.
 *   - Pagination uses the `?page=N` query parameter (1-based). A page with
 *     fewer results than the page size indicates the final page.
 *   - Individual job detail page:
 *     `https://{slug}.catsone.com/careers/{portalID}-{name}/jobs/{jobID}-{slug}`
 *     Contains the full HTML job description and, in some tenants, inline
 *     schema.org JSON-LD (`application/ld+json`) for the JobPosting type.
 *
 * ## URL resolution
 *
 * The adapter accepts:
 *   - `companySlug` (the `{slug}` sub-domain label, e.g. `"authoritypartnersinc"`).
 *   - `companyUrl` (any full careers URL for the tenant — the first sub-domain
 *     label of the host is extracted as the slug, e.g.
 *     `"https://authoritypartnersinc.catsone.com/careers/"` → `"authoritypartnersinc"`).
 *
 * If a `portalPath` is embedded in the provided `companyUrl` (i.e. the URL
 * already points directly to a portal listing page such as
 * `"/careers/86212-General"`), the adapter uses that path directly without
 * first crawling the tenant root.
 *
 * When only a slug / root URL is given, the adapter fetches the tenant root
 * (`/careers/`) and extracts the first available portal path from the HTML.
 *
 * ## Live verification
 *
 * Verified against `authoritypartnersinc.catsone.com` on 2026-06-03:
 *   - GET `https://authoritypartnersinc.catsone.com/careers/86212-General`
 *     → HTTP 200, 28 positions rendered in server-side HTML with
 *     `.cats-job-title` / `.cats-job-location` / `.cats-job-category` nodes.
 *   - GET `https://swan.catsone.com/careers/26625-EPCM-Portal?page=2`
 *     → HTTP 200, second page of ~50 positions confirmed.
 *   - Pagination via `?page=N` confirmed; `?page=1` is equivalent to
 *     no page parameter.
 *   - No `application/json` or `application/ld+json` is present in
 *     listing pages; job detail pages also lack structured data in the
 *     sampled tenants.
 *
 * ## Approach
 *
 * Because CATS portal listings do not embed a job description, the adapter
 * collects stubs (title, url, location, category) from listing pages and
 * then fans out per-job detail requests — bounded by `resultsWanted` — to
 * fetch descriptions. Description fetches use `Promise.allSettled` so a
 * single failed detail request never aborts the batch.
 */

/** Shared apex for every CATS-hosted tenant sub-domain. */
export const CATSONE_APEX = 'catsone.com';

/** Host template for CATS-hosted tenants; `{slug}` is substituted at runtime. */
export const CATSONE_HOST_TEMPLATE = 'https://{slug}.catsone.com';

/** Path for the tenant root careers page (lists all configured portals). */
export const CATSONE_ROOT_CAREERS_PATH = '/careers/';

/**
 * Regex that matches a portal listing path segment on a CATS careers URL.
 * Captures group 1 = the full portal path (e.g. `/careers/86212-General`).
 * The path may have a trailing slash or `?page=N` query param.
 */
export const CATSONE_PORTAL_PATH_RE = /\/careers\/(\d+-[^/?#\s]+)/;

/**
 * Regex that matches a job detail path on a CATS careers URL.
 * Captures group 1 = numeric job ID (e.g. `16818533`).
 */
export const CATSONE_JOB_PATH_RE = /\/jobs\/(\d+)-/;

/** Server-side page size assumed for CATS portal listings (observed in the wild). */
export const CATSONE_PAGE_SIZE = 50;

/** Maximum number of listing pages to traverse per portal before stopping. */
export const CATSONE_MAX_LISTING_PAGES = 20;

/**
 * Maximum number of concurrent per-job detail fetches when descriptions are
 * requested. Kept low to be polite; bounded fan-out via `Promise.allSettled`.
 */
export const CATSONE_DETAIL_CONCURRENCY = 5;

/** Delay (ms) between sequential pagination rounds, to be polite to the server. */
export const CATSONE_REQUEST_DELAY_MS = 300;

/**
 * Default internal results cap. When a caller omits `resultsWanted` entirely
 * we ingest up to this many open roles.
 */
export const CATSONE_DEFAULT_RESULTS = 100;

/**
 * Default request headers. CATS portals expect a browser-like UA; without
 * a realistic user-agent some portal tenants serve a minimal/redirect page.
 */
export const CATSONE_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Env toggle for CATS location heuristics (Spec 1689), layered on top of the
 * shared parser: parenthetical qualifiers ("Leeds (Head Office), UK") are
 * stripped before parsing — the pre-5125 behaviour — so they never end up in
 * the city. `false` / `0` / `off` / `no` → shared-parser output only (Spec
 * 5125); unset or anything else → heuristics on.
 */
export const CATSONE_LOCATION_HEURISTICS_ENV = 'CATSONE_LOCATION_HEURISTICS';

export function catsoneLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[CATSONE_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
