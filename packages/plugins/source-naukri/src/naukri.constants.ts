export const NAUKRI_HEADERS: Record<string, string> = {
  authority: 'www.naukri.com',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'max-age=0',
  'upgrade-insecure-requests': '1',
  appid: '109',
  systemid: 'Naukri',
  Nkparam:
    'Ppy0YK9uSHqPtG3bEejYc04RTpUN2CjJOrqA68tzQt0SKJHXZKzz9M8cZtKLVkoOuQmfe4cTb1r2CwfHaxW5Tg==',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export const NAUKRI_ORIGIN = 'https://www.naukri.com';
export const NAUKRI_SEARCH_URL = `${NAUKRI_ORIGIN}/jobapi/v3/search`;
export const NAUKRI_JOBS_PER_PAGE = 20;
export const NAUKRI_MAX_PAGES = 50;
/**
 * Seconds. The edge tarpits (never answers) unwanted clients; do not burn the
 * 60 s default. `requestTimeout` on the input still wins.
 */
export const NAUKRI_DEFAULT_TIMEOUT_S = 20;
/** Page delay band in seconds: a random wait in `[min, min + band]` between pages. */
export const NAUKRI_PAGE_DELAY_S = 3;
export const NAUKRI_PAGE_DELAY_BAND_S = 4;

/**
 * Row mapping and paging (Spec 1712):
 *   - `current` (default): label-driven location / remote / salary / date
 *     parsing, absolute-URL-safe links, `PLAIN` text, the in-page offset skip,
 *     the `noOfJobs` stop hint and the client-side `hoursOld` filter;
 *   - `legacy`: the pre-1712 mapping, byte for byte (single location, remote
 *     flag from a description scan, range-only salary without an interval,
 *     UTC day, string-concatenated URLs, page-granular offset, no filter).
 */
export type NaukriParserMode = 'current' | 'legacy';
export const NAUKRI_PARSER_ENV = 'NAUKRI_PARSER';
export const NAUKRI_DEFAULT_PARSER: NaukriParserMode = 'current';

/**
 * Failure reporting (Spec 1712):
 *   - `current` (default): the captcha gate (406/403, a captcha message, a
 *     challenge page) is `blocked`, and a non-JSON 200 is `fetch_error`;
 *   - `legacy`: the shared classifier only, as before (a 406 reads
 *     `bad_input`, a 200 captcha body reads as an empty board).
 */
export type NaukriDiagnosticsMode = 'current' | 'legacy';
export const NAUKRI_DIAGNOSTICS_ENV = 'NAUKRI_DIAGNOSTICS';
export const NAUKRI_DEFAULT_DIAGNOSTICS: NaukriDiagnosticsMode = 'current';

/**
 * Normalise a raw mode value. Case/whitespace-insensitive; empty means the
 * default; an unrecognised non-empty value returns `null` so the caller can warn.
 */
export function parseNaukriMode(
  raw: string | null | undefined,
  fallback: 'current' | 'legacy' = 'current',
): 'current' | 'legacy' | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (v === 'current' || v === 'legacy') return v;
  return null;
}
