/**
 * Constants for the Google Jobs scraper (Spec 1704).
 *
 * The request itself is unchanged by Spec 1704; these values govern how the
 * page is read and how far the existing pagination loop may go.
 */

/** The search endpoint the plugin has always used. */
export const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

/**
 * Keys under which the page carries one inline job record each. Tried first;
 * when none of them yields a record, any 9-digit key whose value has the
 * record shape is accepted instead and logged so it can be added here.
 */
export const GOOGLE_JOB_PAYLOAD_KEYS: readonly string[] = ['520084652'];

/**
 * Default cap on follow-up page requests made by the pagination loop, on top
 * of `resultsWanted`. The loop had no page cap before Spec 1704.
 */
export const GOOGLE_DEFAULT_MAX_PAGES = 10;

/**
 * Hard ceiling on {@link GOOGLE_MAX_PAGES_ENV}: a larger value is clamped to it.
 * robots.txt disallows the search path this plugin reads, so an operator
 * override may lower the page count freely but never make it unbounded.
 */
export const GOOGLE_HARD_MAX_PAGES = 30;

/**
 * Longest record slice the bracket scanner will walk from a single key, in
 * characters. A real record (with its description) is a few kilobytes; a scan
 * that runs past this is not a record.
 */
export const GOOGLE_MAX_RECORD_CHARS = 262_144;

/**
 * Total characters the bracket scanner may walk over one page, across every
 * candidate key. Bounds the work an adversarial or unexpectedly large page can
 * cause.
 */
export const GOOGLE_MAX_SCAN_CHARS = 8_388_608;

/** Most key candidates inspected on one page. */
export const GOOGLE_MAX_KEY_CANDIDATES = 500;

/**
 * `true` / `1` / `yes` / `on` restores the pre-Spec-1704 read path in full:
 * the regex title/URL index-pairing parser, the pagination loop without the
 * cursor gate, no cross-page dedupe and no zero-yield diagnostics. That path
 * pairs titles with unrelated URLs and exists only so the old behaviour stays
 * reachable. Read on every scrape.
 */
export const GOOGLE_LEGACY_PARSER_ENV = 'EVER_JOBS_GOOGLE_LEGACY_PARSER';

/**
 * Positive integer overriding {@link GOOGLE_DEFAULT_MAX_PAGES}, clamped to
 * {@link GOOGLE_HARD_MAX_PAGES}. Anything else (unset, blank, zero, negative,
 * non-numeric) keeps the default. Read on every scrape.
 */
export const GOOGLE_MAX_PAGES_ENV = 'EVER_JOBS_GOOGLE_MAX_PAGES';

/** Detail carried by the `unknown` diagnostic when a page yields nothing. */
export const GOOGLE_ZERO_YIELD_DETAIL =
  'no job payload or cursor on first page (payload key rotated or layout changed)';

/** Detail carried by the `unknown` diagnostic when a cursor came with no records. */
export const GOOGLE_CURSOR_NO_RECORDS_DETAIL =
  'forward cursor present but no job records parsed (payload key rotated or layout changed)';

/** Detail carried by the `blocked` diagnostic for a Google interstitial page. */
export const GOOGLE_INTERSTITIAL_DETAIL =
  'Google returned an interstitial (rate-limit, unusual-traffic or JavaScript-required page) instead of results';

/** Whether {@link GOOGLE_LEGACY_PARSER_ENV} selects the pre-Spec-1704 path. */
export function googleLegacyParserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GOOGLE_LEGACY_PARSER_ENV]?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** The follow-up page cap, from {@link GOOGLE_MAX_PAGES_ENV} or the default. */
export function googleMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GOOGLE_MAX_PAGES_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return GOOGLE_DEFAULT_MAX_PAGES;
  const pages = Number(raw);
  if (!Number.isSafeInteger(pages) || pages <= 0) return GOOGLE_DEFAULT_MAX_PAGES;
  return Math.min(pages, GOOGLE_HARD_MAX_PAGES);
}
