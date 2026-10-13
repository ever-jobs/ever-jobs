/**
 * Spec 013 / T09 — Tesla-Playwright constants.
 *
 * Values mirror the upstream Python reference
 * (`OTHERS/Ats-scrapers/tesla/main.py`) exactly: the anti-automation
 * Chromium flag, the careers-search landing URL we navigate to before
 * any in-page `fetch()`, and the 5-second settle window the upstream
 * uses to let Akamai's challenge JS resolve. Identical board / detail
 * endpoint paths to the default `source-tesla` package — keeping them
 * locally inlined here (rather than importing across plugins per
 * `AGENTS.md §5` "no peer plugin imports") preserves plugin isolation
 * at the cost of trivial duplication.
 */

/** Public Tesla origin used for both API + careers-portal URLs. */
export const TESLA_PLAYWRIGHT_BASE_URL = 'https://www.tesla.com';

/** Landing URL the Playwright session navigates to BEFORE any in-page `fetch()`; matches upstream Python's `CAREERS_PAGE`. */
export const TESLA_PLAYWRIGHT_CAREERS_PAGE = `${TESLA_PLAYWRIGHT_BASE_URL}/careers/search/`;

/** Board endpoint path — returns the entire current job catalogue in one GET. */
export const TESLA_PLAYWRIGHT_BOARD_PATH = '/cua-api/apps/careers/state';

/** Per-job detail endpoint template (substituted with `id` per FR-11). */
export const TESLA_PLAYWRIGHT_DETAIL_PATH_TEMPLATE = '/cua-api/careers/job/{id}';

/** Public-facing careers URL prefix; jobs compose into `<prefix>/<title-slug>-<id>`. */
export const TESLA_PLAYWRIGHT_PUBLIC_JOB_BASE = `${TESLA_PLAYWRIGHT_BASE_URL}/careers/search/job`;

/** Ceiling on jobs returned when `input.resultsWanted` is unset. */
export const TESLA_PLAYWRIGHT_DEFAULT_RESULTS_WANTED = 100;

/**
 * Per-job detail-fetch budget map (mirrors `source-tesla`'s map per
 * Q-031). The Playwright path inherits the same budget since the
 * Akamai-challenge solve is a one-time cost — once the session is
 * established, in-page fetch latencies match the pure-HTTP path.
 */
export const TESLA_PLAYWRIGHT_DESCRIPTION_BUDGET: Record<string, number> = {
  board: 0,
  'detail-25': 25,
  'detail-all': Number.POSITIVE_INFINITY,
};

/**
 * Default budget key (Spec 5167). `'board'` rather than `'detail-all'`:
 * the complete corpus costs ~8k+ sequential detail requests and would
 * routinely blow latency and per-IP rate limits; `'detail-25'` yields an
 * arbitrary partial set. Callers who want descriptions opt into
 * `detail-all` explicitly.
 */
export const TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH = 'board';

/**
 * Chromium launch flags. `--disable-blink-features=AutomationControlled`
 * is the load-bearing one for Akamai-bypass — without it, the gateway
 * detects the headless browser within a few hundred ms via the
 * `webdriver` property exposed on `navigator`. The other two flags
 * are belt-and-braces hardening for sandboxed CI environments.
 */
export const TESLA_PLAYWRIGHT_LAUNCH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
] as const;

/**
 * Time (ms) to settle on the careers-search page after the initial
 * `goto()` resolves. Mirrors upstream Python's `time.sleep(5)`.
 * Akamai's challenge JS sometimes takes 2-4 seconds to fully resolve;
 * 5 s gives a safety margin without making the per-call latency
 * meaningfully worse than NFR-2 already accounts for.
 */
export const TESLA_PLAYWRIGHT_SETTLE_MS = 5_000;

/**
 * Initial-page navigation timeout (ms). The careers-search page can
 * stall briefly while Akamai's challenge resolves; 60 s mirrors
 * upstream Python's `timeout=60000`.
 */
export const TESLA_PLAYWRIGHT_GOTO_TIMEOUT_MS = 60_000;

/**
 * Sentinel error codes (Spec 013 / § 7.3 / FR-13). Recorded via
 * `Logger.warn` when the matching failure mode is detected. NOT
 * thrown — `scrape()` always resolves with an empty `JobResponseDto`
 * per `AGENTS.md §10`.
 */
export const TESLA_PLAYWRIGHT_ERR_UNAVAILABLE = 'ERR_TESLA_PLAYWRIGHT_UNAVAILABLE';
export const TESLA_PLAYWRIGHT_ERR_NAV_FAILED = 'ERR_TESLA_PLAYWRIGHT_NAV_FAILED';
export const TESLA_PLAYWRIGHT_ERR_FETCH_FAILED = 'ERR_TESLA_PLAYWRIGHT_FETCH_FAILED';
