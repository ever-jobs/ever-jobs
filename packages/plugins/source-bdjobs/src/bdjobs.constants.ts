// ── Public JSON API (Spec 1711, the default `BDJOBS_MODE=api`) ──────────────

/** Honest, identifying User-Agent. `input.userAgent` overrides it per call. */
export const BDJOBS_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/**
 * Request headers for the JSON API. No browser User-Agent, HTML `Accept` or
 * `Referer`: the API answers an honest client without them.
 */
export const BDJOBS_HEADERS: Record<string, string> = {
  'User-Agent': BDJOBS_USER_AGENT,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.8',
};

/** Paged search endpoint (`keyword`, `pg`, `rpp`, `isPro`, `workplace`). */
export const BDJOBS_SEARCH_URL = 'https://api.bdjobs.com/Jobs/api/JobSearch/GetJobSearch';

/** Per-job details endpoint (`jobId`, `ln`). */
export const BDJOBS_DETAILS_URL =
  'https://gateway.bdjobs.com/jobapply/api/JobSubsystem/Job-Details';

/** Public job page; emitted as `jobUrl`, never fetched. */
export const BDJOBS_JOB_URL_BASE = 'https://bdjobs.com/h/details/';

/** Every hop of a redirect must stay on this registrable domain (Spec 1689). */
export const BDJOBS_ALLOWED_REDIRECT_HOSTS: readonly string[] = ['bdjobs.com'];

/** Rows per search page. The site itself asks for 30; larger values are unverified. */
export const BDJOBS_PAGE_SIZE = 30;

/** Most search pages one scrape may fetch, whatever the board reports. */
export const BDJOBS_MAX_PAGES = 20;

/** Extra pages allowed beyond the arithmetic need, to absorb client-side filter losses. */
export const BDJOBS_PAGE_HEADROOM = 2;

/** Default `resultsWanted` when the caller leaves it unset. */
export const BDJOBS_DEFAULT_RESULTS_WANTED = 15;

/** Default per-request timeout in SECONDS when `input.requestTimeout` is unset. */
export const BDJOBS_DEFAULT_TIMEOUT_S = 30;

/**
 * Wall-clock budget for the sequential details pass. A details call took about
 * 3 s in the probe and the fan-out deadline is 120 s; jobs not reached keep
 * their list-only fields.
 */
export const BDJOBS_DETAIL_TIME_BUDGET_MS = 45_000;

/**
 * Consecutive failed details calls after which the pass stops: a details host
 * that is down should cost a few requests, not one per job.
 */
export const BDJOBS_DETAIL_MAX_CONSECUTIVE_FAILURES = 3;

/** Default `descriptionDepth` key. */
export const BDJOBS_DEFAULT_DESCRIPTION_DEPTH = 'detail-25';

/** Details-call budget per `descriptionDepth` value. */
export const BDJOBS_DESCRIPTION_BUDGET: Record<string, number> = {
  board: 0,
  'detail-25': 25,
  'detail-all': Number.POSITIVE_INFINITY,
};

/** `workplace` search value for work-from-home jobs. */
export const BDJOBS_WORKPLACE_REMOTE = '1';

/** Delay between search pages, in ms (the historical `delay` / `bandDelay`). */
export const BDJOBS_PAGE_DELAY_MIN_MS = 2_000;
export const BDJOBS_PAGE_DELAY_MAX_MS = 4_000;

/** Delay between details calls, in ms. */
export const BDJOBS_DETAIL_DELAY_MIN_MS = 1_000;
export const BDJOBS_DETAIL_DELAY_MAX_MS = 2_000;

/** Currency every salary on the board is quoted in. */
export const BDJOBS_CURRENCY = 'BDT';

/** ISO 3166-1 alpha-2 code of the board's only country. */
export const BDJOBS_COUNTRY_CODE = 'BD';

/**
 * Display string for the board's country. The string, not
 * `Country.BANGLADESH`: `LocationDto.displayLocation()` prints a string
 * country verbatim, so the enum value would render as `BANGLADESH`.
 */
export const BDJOBS_COUNTRY_NAME = 'Bangladesh';

// ── Strategy switch ─────────────────────────────────────────────────────────

/**
 * `api` (default) scrapes the public JSON API. `html` runs the pre-1711
 * cheerio scraper of the legacy search page. That page now redirects to a
 * script-rendered shell, so `html` is kept only so the old path stays
 * reachable; it is never an automatic fallback.
 */
export const BDJOBS_MODE_ENV = 'BDJOBS_MODE';

/** Alias read only when `BDJOBS_MODE` is unset; `legacy-html` selects `html`. */
export const BDJOBS_STRATEGY_ENV = 'BDJOBS_STRATEGY';

export type BdjobsMode = 'api' | 'html';

// ── Legacy HTML path (`BDJOBS_MODE=html`) ───────────────────────────────────

/** @deprecated Legacy HTML path only (`BDJOBS_MODE=html`). */
export const BDJOBS_LEGACY_BASE_URL = 'https://jobs.bdjobs.com';

/** @deprecated Legacy HTML path only (`BDJOBS_MODE=html`). Now 302s to the new site. */
export const BDJOBS_LEGACY_SEARCH_URL = 'https://jobs.bdjobs.com/jobsearch.asp';

/**
 * Headers for the legacy HTML path: the same honest User-Agent, with an HTML
 * `Accept`.
 * @deprecated Legacy HTML path only (`BDJOBS_MODE=html`).
 */
export const BDJOBS_LEGACY_HTML_HEADERS: Record<string, string> = {
  'User-Agent': BDJOBS_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
};

/**
 * The pre-1711 value of `BDJOBS_HEADERS`, kept for reference only. No code path
 * sends it: under the crawl policy every request identifies itself honestly.
 * @deprecated Not used by any path since Spec 1711.
 */
export const BDJOBS_LEGACY_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  Connection: 'keep-alive',
  Referer: 'https://jobs.bdjobs.com/',
  'Cache-Control': 'max-age=0',
};

/** @deprecated Legacy HTML path only (`BDJOBS_MODE=html`). */
export const BDJOBS_SEARCH_PARAMS: Record<string, string> = {
  hidJobSearch: 'jobsearch',
};

/** @deprecated Legacy HTML path only (`BDJOBS_MODE=html`). */
export const BDJOBS_JOB_SELECTORS = [
  'div.job-item',
  'div.sout-jobs-wrapper',
  'div.norm-jobs-wrapper',
  'div.featured-wrap',
];

/**
 * Date layouts the legacy cards used. Before Spec 1711 this list was exported
 * but never read; `parseBdjobsCalendarDate` now parses exactly these layouts
 * without constructing a `Date` from free text.
 * @deprecated Legacy HTML path only (`BDJOBS_MODE=html`).
 */
export const BDJOBS_DATE_FORMATS = [
  'dd MMM yyyy',
  'dd-MMM-yyyy',
  'dd MMMM yyyy',
  'MMMM dd, yyyy',
  'dd/MM/yyyy',
];
