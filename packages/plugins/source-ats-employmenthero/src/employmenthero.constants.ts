/**
 * Constants for the Employment Hero careers platform.
 *
 * Employment Hero (employmenthero.com — an AU / NZ / SEA / UK all-in-one HR, payroll &
 * recruitment platform; its recruitment arm powers branded candidate-facing career pages and
 * embeddable job widgets for a large multi-tenant base) addresses each tenant's public,
 * unauthenticated job board by a per-tenant **friendly id** (organisation slug) on the shared
 * jobs host:
 *
 *   https://jobs.employmenthero.com/organisations/{slug}        (branded employer job board)
 *   https://employmenthero.com/jobs/organisations/{slug}/       (the same board, canonical host)
 *   https://employmenthero.com/jobs/position/{friendlyId}/      (per-role public detail / apply page)
 *
 * The `jobs.employmenthero.com/organisations/{slug}` board 307-redirects to the canonical
 * `employmenthero.com/jobs/organisations/{slug}/` page, a server-rendered listing whose own
 * client reads a **single public, anonymous JSON API** baked into the page as `jobsBaseUrl`
 * (no bearer token — the board fetches it for anonymous visitors):
 *
 *   Career-page jobs feed (host `services.employmenthero.com`):
 *     GET https://services.employmenthero.com/ats/api/v1/career_page/organisations/{slug}/jobs
 *         ?page_index={n}&item_per_page={size}
 *       → { data: { items: [ { …role… } ], page_index, item_per_page, total_pages, total_items } }
 *
 *   Each `data.items[]` role carries a stable string `id` (UUID — the ATS id), a `title`,
 *   a `friendly_id` (the `{slug}-{title}-{shortid}` token that forms the public
 *   `/jobs/position/{friendlyId}/` detail URL), an HTML `description`, a `company_overview`,
 *   `country_code` (ISO-3166 alpha-2), `vendor_location_name` (free-text location line),
 *   `remote` (bool) + `workplace_type` (`remote_anywhere` / `hybrid` / on-site) +
 *   `remote_setting` (`{ anywhere, country_code, … }`), `team_name` (≈ department),
 *   `employment_type_name` (e.g. `Full-time`), `employment_term_name` (e.g. `Permanent`),
 *   `experience_level_name`, `organisation_name`, `organisation_friendly_id`,
 *   `organisation_logo`, salary fields, and `created_at` (ISO-8601 timestamp). The envelope
 *   carries first-class pagination meta (`page_index`, `total_pages`, `total_items`), so the
 *   adapter walks `page_index` until it reaches `total_pages` (bounded by a page cap), rather
 *   than depending on a client-rendered DOM, a headless browser, or any authenticated
 *   Employment Hero API.
 *
 * The adapter resolves the tenant slug from `companySlug` or from a `companyUrl` on a
 * `jobs.employmenthero.com` / `employmenthero.com` host (an `/organisations/{slug}` path),
 * fetches the career-page jobs feed, drains it page by page, and maps each role. An unknown
 * slug (the feed answers HTTP 404 `organisation_not_found`), a tenant with no roles, or an
 * empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx/5xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than throwing, so
 * a single bad tenant never nukes a batch run.
 *
 * Surface confidence (researched + verified live 2026-06-04, no authentication):
 *  - Confirmed the platform + slug addressing
 *    (`jobs.employmenthero.com/organisations/{slug}` 307→
 *    `employmenthero.com/jobs/organisations/{slug}/`) and the API base host baked into the
 *    board page as `jobsBaseUrl`
 *    (`services.employmenthero.com/ats/api/v1/career_page/organisations/{slug}/jobs`).
 *  - Confirmed
 *    `GET https://services.employmenthero.com/ats/api/v1/career_page/organisations/employmenthero/jobs`
 *    returns `{ data: { items: [ { id: "ed3c8943-…", title: "HR Advisor",
 *    friendly_id: "employment-hero-hr-advisor-hbg0o", country_code: "GB",
 *    vendor_location_name: "Greater London, SouthEast E1", remote: true,
 *    workplace_type: "remote_anywhere", team_name: "HR Advisory",
 *    employment_type_name: "Full-time", created_at: "2026-06-02T12:51:22Z",
 *    description: "<p>…</p>", … } ], page_index: 1, item_per_page: 10,
 *    total_pages: 9, total_items: 90 } }` anonymously.
 *  - Confirmed `?page_index=2&item_per_page=5` returns the next 5 roles with
 *    `total_pages: 18` (page-index pagination), and that an unknown slug returns HTTP 404
 *    `{ error: { errors: [ { reason: "organisation_not_found" } ] } }`. verified=true.
 */

/** Root domain — used to recognise tenant URLs passed via `companyUrl`. */
export const EMPLOYMENTHERO_ROOT_DOMAIN = 'employmenthero.com';

/** Public candidate-facing job-board host — boards live at `jobs.employmenthero.com/organisations/{slug}`. */
export const EMPLOYMENTHERO_BOARD_HOST = 'jobs.employmenthero.com';

/** Canonical job-board origin (the host the board host redirects to, and where `/jobs/position/{id}/` lives). */
export const EMPLOYMENTHERO_CANONICAL_ORIGIN = 'https://employmenthero.com';

/** API host serving the public, anonymous career-page jobs feed the board consumes. */
export const EMPLOYMENTHERO_API_ORIGIN = 'https://services.employmenthero.com';

/** Path template (after the origin) of the public, anonymous career-page jobs feed. */
export const EMPLOYMENTHERO_JOBS_PATH = 'ats/api/v1/career_page/organisations';

/** Builds the public career-page jobs feed URL for a tenant slug. */
export const employmentHeroJobsUrl = (slug: string): string =>
  `${EMPLOYMENTHERO_API_ORIGIN}/${EMPLOYMENTHERO_JOBS_PATH}/${encodeURIComponent(slug)}/jobs`;

/** Builds a public `/jobs/position/{friendlyId}/` detail URL on the canonical host. */
export const employmentHeroPositionUrl = (friendlyId: string): string =>
  `${EMPLOYMENTHERO_CANONICAL_ORIGIN}/jobs/position/${encodeURIComponent(friendlyId)}/`;

/** Builds a public `/jobs/organisations/{slug}/` board URL on the canonical host. */
export const employmentHeroBoardUrl = (slug: string): string =>
  `${EMPLOYMENTHERO_CANONICAL_ORIGIN}/jobs/organisations/${encodeURIComponent(slug)}/`;

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: when a caller omits
 * `resultsWanted` entirely we ingest up to 100 of the tenant's open roles.
 */
export const EMPLOYMENTHERO_DEFAULT_RESULTS = 100;

/**
 * Per-page size requested from the career-page jobs feed. The feed paginates by `page_index`
 * with an `item_per_page` control; a moderate page size keeps the number of round-trips low for
 * large tenants while staying well inside the feed's own limits.
 */
export const EMPLOYMENTHERO_PAGE_SIZE = 50;

/**
 * Hard ceiling on feed pages fetched per scrape. The feed exposes first-class pagination meta
 * (`total_pages`), so we normally stop at `total_pages`; this ceiling guards against an
 * unbounded / inconsistent pager (Employment Hero tenants can be large, so the cap is generous).
 */
export const EMPLOYMENTHERO_MAX_PAGES = 25;

/**
 * Upper bound (seconds) on the per-request HTTP timeout. An unresponsive Employment Hero host
 * can connect-then-hang, so we cap the shared client's 60s default to keep graceful-degradation
 * well inside callers' budgets; a healthy tenant responds in well under a second. A caller may
 * request a SHORTER timeout — we only bound the upper end.
 */
export const EMPLOYMENTHERO_DEFAULT_TIMEOUT_SECONDS = 15;

/**
 * Default request headers. The board's own client sends a browser-like UA and a JSON Accept for
 * anonymous visitors; mirroring keeps us on the public anonymous path. An Origin / Referer on
 * the canonical board host keeps the request indistinguishable from the board's own fetch.
 */
export const EMPLOYMENTHERO_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: EMPLOYMENTHERO_CANONICAL_ORIGIN,
  Referer: `${EMPLOYMENTHERO_CANONICAL_ORIGIN}/`,
};

/**
 * The `workplace_type` token Employment Hero emits for fully-remote roles, when present
 * (e.g. `remote_anywhere`). Matched as a substring so any `remote_*` variant counts.
 */
export const EMPLOYMENTHERO_REMOTE_TYPE = 'remote';

/**
 * Detects remote / home-working roles across the title, location, and team fields, complementing
 * the structured `remote` flag and `workplace_type` token Employment Hero emits.
 */
export const EMPLOYMENTHERO_REMOTE_REGEX =
  /\b(remote|home[\s-]?office|telecommute|teleworking|wfh|work\s*from\s*home|fully\s*remote|anywhere)\b/i;

/**
 * Env toggle for Employment Hero location heuristics (Spec 1689), layered on
 * top of the shared parser: a trailing postcode is stripped from the region
 * ("Sydney, NSW 2000" → state "NSW", "Greater London, SouthEast E1" → state
 * "SouthEast") — the pre-5125 behaviour. `false` / `0` / `off` / `no` →
 * shared-parser output only (Spec 5125); unset or anything else → on.
 */
export const EMPLOYMENTHERO_LOCATION_HEURISTICS_ENV = 'EMPLOYMENTHERO_LOCATION_HEURISTICS';

export function employmentHeroLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[EMPLOYMENTHERO_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
