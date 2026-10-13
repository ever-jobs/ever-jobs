/**
 * Spec 013 / T07 — Tesla constants.
 *
 * Values mirror the upstream Python reference
 * (`OTHERS/Ats-scrapers/tesla/main.py`) so a future contributor can
 * `git diff` the two and convince themselves the wire format matches:
 * board endpoint, per-job detail endpoint, and the canonical
 * `https://www.tesla.com/careers/search/job/<slug>-<id>` URL pattern.
 *
 * **HTTP-first with a lazy browser fallback** (Spec 5167): when the plain
 * board GET fails for any reason (4xx/5xx, non-JSON body, network error),
 * the service retries the same endpoints through an in-page `fetch()`
 * inside a lazily imported Chromium session. No `playwright` reference at
 * module scope — a workspace without the dep still boots clean; the
 * OPTIONAL `source-tesla-playwright` companion remains for operators who
 * want browser-first.
 */

/** Public Tesla origin used for both API + careers-portal URLs. */
export const TESLA_BASE_URL = 'https://www.tesla.com';

/** Board endpoint path — returns the entire current job catalogue in one GET. */
export const TESLA_BOARD_PATH = '/cua-api/apps/careers/state';

/**
 * Per-job detail endpoint template. Substituted with the listing's
 * `id` per Spec 013 / FR-11. We do NOT pre-bind this template at
 * load time so the test harness can re-import the constant cleanly
 * without monkey-patching string interpolation.
 */
export const TESLA_DETAIL_PATH_TEMPLATE = '/cua-api/careers/job/{id}';

/**
 * Public-facing careers URL pattern: the board endpoint exposes
 * `id` + `t` (title) only; the user-visible URL composes a
 * kebab-case slug from the title plus the trailing `-<id>` segment
 * (mirrors upstream Python's `create_job_url_slug()`).
 */
export const TESLA_PUBLIC_JOB_BASE = `${TESLA_BASE_URL}/careers/search/job`;

/** Ceiling on jobs returned when `input.resultsWanted` is unset. */
export const TESLA_DEFAULT_RESULTS_WANTED = 100;

/**
 * Per-job detail-fetch budget map (Spec 013 / Q-031 / FR-11).
 * `'board'` skips detail fetches entirely (descriptions stay null).
 * `'detail-25'` caps follow-ups at the first 25 listings.
 * `'detail-all'` exposes the full corpus for operators who want every
 * description — at catalogue scale that is one request per listing
 * (~8k+ sequential GETs, tens of minutes, and likely to trip per-IP
 * request-rate limits partway).
 */
export const TESLA_DESCRIPTION_BUDGET: Record<string, number> = {
  board: 0,
  'detail-25': 25,
  'detail-all': Number.POSITIVE_INFINITY,
};

/**
 * Default budget key. `'board'` rather than `'detail-all'`: the complete
 * corpus costs ~8k+ sequential detail requests and would routinely blow
 * latency and per-IP rate limits; `'detail-25'` yields an arbitrary
 * partial set. Callers who want descriptions opt into `detail-all`
 * explicitly (Spec 5167).
 */
export const TESLA_DEFAULT_DESCRIPTION_DEPTH = 'board';

/**
 * Browser-shaped headers. Same UA the upstream Python launches
 * Chromium with. `Accept: application/json` is the wire-protocol
 * negotiation hint — without it Tesla's Akamai-fronted gateway is
 * more likely to serve a `text/html` challenge page even on a
 * legitimate request.
 */
export const TESLA_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  Referer: `${TESLA_BASE_URL}/careers/search/`,
  Origin: TESLA_BASE_URL,
};

/**
 * HTTP status codes Akamai Bot Manager uses when challenging a
 * non-browser client. A response carrying any of these — OR an HTML
 * body when JSON was requested — triggers the
 * `ERR_TESLA_AKAMAI_CHALLENGE` sentinel and an empty
 * `JobResponseDto` per FR-12.
 */
export const TESLA_AKAMAI_STATUS_CODES: ReadonlySet<number> = new Set([
  403, 503,
]);

/**
 * Sentinel error codes (Spec 013 / § 7.3 / FR-12). Recorded via
 * `Logger.warn` when the matching failure mode is detected. NOT
 * thrown — `scrape()` always resolves with an empty `JobResponseDto`
 * per `AGENTS.md §10`.
 */
export const TESLA_ERR_AKAMAI_CHALLENGE = 'ERR_TESLA_AKAMAI_CHALLENGE';
export const TESLA_ERR_FETCH_FAILED = 'ERR_TESLA_FETCH_FAILED';

/**
 * Spec 5167 — browser-fallback constants.
 *
 * `TESLA_CAREERS_PAGE`: landing URL the fallback session navigates to before
 * any in-page `fetch()` — loading the careers SPA is what lets the site's
 * protection JS resolve and plant its cookies on the browser context.
 */
export const TESLA_CAREERS_PAGE = `${TESLA_BASE_URL}/careers/search/`;

/**
 * Chromium launch flags. `--disable-blink-features=AutomationControlled` is
 * load-bearing for Akamai bypass — without it the gateway detects the
 * headless browser via the `webdriver` property within a few hundred ms.
 * The other two are belt-and-braces for sandboxed CI environments.
 */
export const TESLA_LAUNCH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
] as const;

/** Settle time after the careers-page `goto` — the site's protection JS can take a few seconds to resolve. */
export const TESLA_SETTLE_MS = 5_000;

/** Careers-page navigation timeout (ms). */
export const TESLA_GOTO_TIMEOUT_MS = 60_000;

/** Gap between in-page board-fetch retries while the protection JS finishes (ms). */
export const TESLA_BOARD_RETRY_MS = 4_000;

/** Sentinel error codes for the browser-fallback path (Spec 5167). */
export const TESLA_ERR_BROWSER_UNAVAILABLE = 'ERR_TESLA_BROWSER_UNAVAILABLE';
export const TESLA_ERR_BROWSER_NAV = 'ERR_TESLA_BROWSER_NAV';
export const TESLA_ERR_BROWSER_FETCH_FAILED = 'ERR_TESLA_BROWSER_FETCH_FAILED';
