/** Site origin. Every URL this plugin requests is built from it. */
export const WELLFOUND_BASE_URL = 'https://wellfound.com';

/**
 * The public all-roles feed (`/jobs`). Also the target of the `feed` route
 * mode, the plugin's pre-Spec-1708 entry point. The site ignores a `q`
 * parameter on it, so none is ever sent: the search term is applied locally.
 */
export const WELLFOUND_JOBS_URL = `${WELLFOUND_BASE_URL}/jobs`;

/** Delay between two page requests of one scrape (ms). Pages are fetched sequentially. */
export const WELLFOUND_DELAY_MIN = 3000;
export const WELLFOUND_DELAY_MAX = 7000;

/**
 * Hard cap on landing pages fetched per route attempt, page 1 included. A
 * page holds 20 companies with 1-3 listings each (about 36-60 listings), so
 * this bounds one scrape to roughly 360-600 listings however many pages the
 * site declares.
 */
export const WELLFOUND_MAX_PAGES = 10;

/** `resultsWanted` when the caller leaves it unset. */
export const WELLFOUND_DEFAULT_RESULTS = 15;

/**
 * Honest identification for plain HTTP requests, used when the caller does
 * not pass `userAgent`. The landing pages answer it with a normal 200.
 */
export const WELLFOUND_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/** Content negotiation for the HTML landing pages. */
export const WELLFOUND_HTTP_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * The server-rendered Next.js payload. Attribute order does not matter, and
 * the lazy body stops at the first closing tag.
 */
export const NEXT_DATA_RE = /<script\b[^>]*\bid=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i;

/**
 * Search terms whose role slug is not their plain slugified form. Keys are
 * lowercased with whitespace collapsed.
 */
export const WELLFOUND_ROLE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  swe: 'software-engineer',
  'ml engineer': 'machine-learning-engineer',
  'frontend developer': 'frontend-engineer',
});

/** Location inputs that mean "remote" rather than a place. Lowercased. */
export const WELLFOUND_REMOTE_LOCATION_WORDS: ReadonlySet<string> = new Set([
  'remote',
  'anywhere',
  'worldwide',
]);

/** Append `?page=N` for N >= 2; page 1 is the bare path. */
export function withPage(url: string, page: number): string {
  return page > 1 ? `${url}?page=${page}` : url;
}

/** `/role/{role}`: every listing for one role. */
export function roleUrl(role: string, page = 1): string {
  return withPage(`${WELLFOUND_BASE_URL}/role/${role}`, page);
}

/** `/role/l/{role}/{location}`. Never built without a location: that path is a 404. */
export function roleLocationUrl(role: string, location: string, page = 1): string {
  return withPage(`${WELLFOUND_BASE_URL}/role/l/${role}/${location}`, page);
}

/** `/role/r/{role}`: remote-eligible listings for one role. */
export function roleRemoteUrl(role: string, page = 1): string {
  return withPage(`${WELLFOUND_BASE_URL}/role/r/${role}`, page);
}

/** `/location/{location}`: every listing in one place. */
export function locationUrl(location: string, page = 1): string {
  return withPage(`${WELLFOUND_BASE_URL}/location/${location}`, page);
}

/** `/jobs`: the all-roles feed. */
export function jobsUrl(page = 1): string {
  return withPage(WELLFOUND_JOBS_URL, page);
}

// --- Operator options (Spec 1708) ------------------------------------------
//
// Each option is read from the environment on every scrape, so it can be
// flipped without a rebuild. Unrecognised values fall back to the default
// with a warning. The non-default value of each restores a pre-Spec-1708
// behaviour.

/**
 * How pages are fetched:
 *   - `http` (default): plain HTTP. A bot challenge is reported as `blocked`,
 *     never worked around.
 *   - `browser`: every page through the shared browser pool, the transport the
 *     plugin used before Spec 1708.
 */
export type WellfoundFetchMode = 'http' | 'browser';
export const WELLFOUND_FETCH_MODE_ENV = 'WELLFOUND_FETCH_MODE';
export const WELLFOUND_DEFAULT_FETCH_MODE: WellfoundFetchMode = 'http';

/**
 * Which pages are requested:
 *   - `landing` (default): the role and location landing pages, which the site
 *     filters server-side.
 *   - `feed`: only the `/jobs` feed, filtered locally, as before Spec 1708.
 */
export type WellfoundRouteMode = 'landing' | 'feed';
export const WELLFOUND_ROUTE_MODE_ENV = 'WELLFOUND_ROUTE_MODE';
export const WELLFOUND_DEFAULT_ROUTE_MODE: WellfoundRouteMode = 'landing';

/**
 * What a listing's `description` field is taken to be:
 *   - `markdown` (default): Markdown, which is what the site serves.
 *   - `html`: HTML, the pre-Spec-1708 reading (HTML output verbatim, Markdown
 *     through the HTML converter, plain text through the HTML stripper).
 */
export type WellfoundDescriptionSource = 'markdown' | 'html';
export const WELLFOUND_DESCRIPTION_SOURCE_ENV = 'WELLFOUND_DESCRIPTION_SOURCE';
export const WELLFOUND_DEFAULT_DESCRIPTION_SOURCE: WellfoundDescriptionSource = 'markdown';

/**
 * Shape of `jobUrl`:
 *   - `id-slug` (default): `/jobs/{id}-{slug}`, the listing's real address.
 *   - `slug`: `/jobs/{slug}` (or `/jobs/{id}` without a slug), the
 *     pre-Spec-1708 shape.
 */
export type WellfoundJobUrlStyle = 'id-slug' | 'slug';
export const WELLFOUND_JOB_URL_STYLE_ENV = 'WELLFOUND_JOB_URL_STYLE';
export const WELLFOUND_DEFAULT_JOB_URL_STYLE: WellfoundJobUrlStyle = 'id-slug';

/**
 * Normalise a raw option value against its allowed set. Blank or unset gives
 * the default; an unrecognised non-empty value gives `null` so the caller can
 * warn before using the default.
 */
export function parseWellfoundOption<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export const WELLFOUND_FETCH_MODES: readonly WellfoundFetchMode[] = ['http', 'browser'];
export const WELLFOUND_ROUTE_MODES: readonly WellfoundRouteMode[] = ['landing', 'feed'];
export const WELLFOUND_DESCRIPTION_SOURCES: readonly WellfoundDescriptionSource[] = ['markdown', 'html'];
export const WELLFOUND_JOB_URL_STYLES: readonly WellfoundJobUrlStyle[] = ['id-slug', 'slug'];
