import { Site } from '@ever-jobs/models';

/**
 * Level (jobsbylevel.com) — Spec 1693.
 *
 * Every listing carries an "AI Level" from 1 to 4 that rates how central AI is
 * to the daily work (not seniority). Two robots-allowed read paths are used:
 *
 * - `mcp` (default): the operator's documented, key-less MCP server at `/mcp`
 *   (Streamable HTTP, stateless, read-only). `search_jobs` lists and
 *   `get_job` returns one listing with its full plain-text description. The
 *   operator publishes it for "any HTTP client" and serves the same fields as
 *   its REST API.
 * - `feed`: the public RSS feed `/feed.xml` (newest ~1 000 listings, no
 *   location, salary or level) plus the listing page's JSON-LD for details.
 *
 * The REST API under `/api/` is NOT used: robots.txt disallows `/api/` for
 * every user agent, including the aggregators it allowlists for `/feeds/`.
 * `/feeds/`, `/go/` and `/md/` are disallowed too and are never requested.
 */

/** Site value for this plugin (`Site.JOBSBYLEVEL = 'jobsbylevel'`). */
export const JOBSBYLEVEL_SITE: Site = Site.JOBSBYLEVEL;

export const JOBSBYLEVEL_HOST = 'jobsbylevel.com';
export const JOBSBYLEVEL_BASE_URL = `https://${JOBSBYLEVEL_HOST}`;
export const JOBSBYLEVEL_MCP_URL = `${JOBSBYLEVEL_BASE_URL}/mcp`;
export const JOBSBYLEVEL_FEED_URL = `${JOBSBYLEVEL_BASE_URL}/feed.xml`;
export const JOBSBYLEVEL_JOB_PATH = '/jobs/';
export const JOBSBYLEVEL_COMPANY_PATH = '/companies/';

/**
 * Path prefixes robots.txt disallows for `User-Agent: *`. The service refuses
 * to build a request URL under any of them (defence in depth: no code path
 * should produce one in the first place).
 */
export const JOBSBYLEVEL_DISALLOWED_PATH_PREFIXES: readonly string[] = [
  '/api/',
  '/feeds/',
  '/go/',
  '/md/',
  '/jobs/edit/',
  '/confirm/',
  '/unsubscribe/',
  '/panel/',
];

/** Honest, identifiable UA. The probe got a 200 on every path with it. */
export const JOBSBYLEVEL_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

export const JOBSBYLEVEL_MCP_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

export const JOBSBYLEVEL_FEED_HEADERS: Record<string, string> = {
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
};

export const JOBSBYLEVEL_DETAIL_HTML_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml;q=0.9',
};

export const JOBSBYLEVEL_MCP_SEARCH_TOOL = 'search_jobs';
export const JOBSBYLEVEL_MCP_DETAIL_TOOL = 'get_job';

/** `search_jobs` returns at most 20 items per page (operator docs, verified 2026-09-25). */
export const JOBSBYLEVEL_MCP_PAGE_SIZE = 20;

export const JOBSBYLEVEL_DEFAULT_RESULTS = 15;

/** Default listing-page cap: at most 200 items scanned per call on the MCP path. */
export const JOBSBYLEVEL_DEFAULT_MAX_PAGES = 10;
/** Hard ceiling for the `JOBSBYLEVEL_MAX_PAGES` override. */
export const JOBSBYLEVEL_MAX_PAGES_CEILING = 25;

/**
 * Minimum gap between two requests to the host. The operator's fair use is
 * about 60 requests per minute per IP (`x-ratelimit-limit: 60`).
 */
export const JOBSBYLEVEL_MIN_INTERVAL_MS = 1_100;

/** Detail fetches per `descriptionDepth`. The default stays below the repo-wide 25. */
export const JOBSBYLEVEL_DETAIL_BUDGET: Readonly<Record<'board' | 'detail-25' | 'detail-all', number>> = {
  board: 0,
  'detail-25': 5,
  'detail-all': 25,
};

/** Wall-clock budget for the whole detail phase of one scrape. */
export const JOBSBYLEVEL_DETAIL_TIME_BUDGET_MS = 30_000;

/**
 * Ceiling, in seconds, on one detail request. An uncached listing page took
 * 72 s to render in the probe; abandoning it keeps the scrape moving.
 */
export const JOBSBYLEVEL_DETAIL_TIMEOUT_S = 20;

export const JOBSBYLEVEL_PAGE_CACHE_TTL_MS = 10 * 60_000;
export const JOBSBYLEVEL_PAGE_CACHE_MAX = 50;
export const JOBSBYLEVEL_DETAIL_CACHE_MAX = 200;

/** Items read from one RSS body at most (the live feed held ~1 000). */
export const JOBSBYLEVEL_FEED_MAX_ITEMS = 2_000;

/** Longest free-text value forwarded to the MCP tool arguments. */
export const JOBSBYLEVEL_MAX_ARG_LENGTH = 200;

/** Salary bounds at or above this with no stated period are read as yearly. */
export const JOBSBYLEVEL_YEARLY_SALARY_FLOOR = 10_000;

/**
 * Published score bands: a score at or above the lower bound maps to the
 * level. Checked top-down.
 */
export const JOBSBYLEVEL_LEVEL_BANDS: ReadonlyArray<readonly [number, number]> = [
  [80, 4],
  [60, 3],
  [40, 2],
  [0, 1],
];

// ── Environment overrides (all read on every scrape) ────────────────────────

/** `mcp` (default) or `feed`. */
export const JOBSBYLEVEL_TRANSPORT_ENV = 'JOBSBYLEVEL_TRANSPORT';
/**
 * When the MCP listing fails before any job was collected, retry once through
 * the RSS feed. Default on; `false` / `0` / `no` / `off` disables it.
 */
export const JOBSBYLEVEL_FEED_FALLBACK_ENV = 'JOBSBYLEVEL_FEED_FALLBACK';
/** Keep only listings at or above this AI level (1-4). Sent to the server too. */
export const JOBSBYLEVEL_MIN_AI_LEVEL_ENV = 'JOBSBYLEVEL_MIN_AI_LEVEL';
/** Keep only listings at or below this AI level (1-4). Sent to the server too. */
export const JOBSBYLEVEL_MAX_AI_LEVEL_ENV = 'JOBSBYLEVEL_MAX_AI_LEVEL';
/** Comma-separated category slugs (e.g. `software-engineering,data`), matched client-side. */
export const JOBSBYLEVEL_CATEGORIES_ENV = 'JOBSBYLEVEL_CATEGORIES';
/** Listing-page cap, 1 to {@link JOBSBYLEVEL_MAX_PAGES_CEILING}. */
export const JOBSBYLEVEL_MAX_PAGES_ENV = 'JOBSBYLEVEL_MAX_PAGES';
/** Response cache TTL in ms; `0` turns the cache off. */
export const JOBSBYLEVEL_CACHE_TTL_ENV = 'JOBSBYLEVEL_CACHE_TTL_MS';
/**
 * Emit the additive `aiLevel` key on each job. Default on; `false` / `0` /
 * `no` / `off` leaves it out, so every job has only the standard DTO keys.
 */
export const JOBSBYLEVEL_EMIT_AI_LEVEL_ENV = 'JOBSBYLEVEL_EMIT_AI_LEVEL';
