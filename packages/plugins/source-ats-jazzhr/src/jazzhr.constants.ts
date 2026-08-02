/** JazzHR public career board URL (slug interpolated at runtime). */
export const jazzhrBoardUrl = (slug: string): string =>
  `https://${encodeURIComponent(slug)}.applytojob.com/apply/jobs/`;

/** JazzHR public job detail page URL for a board code. */
export const jazzhrDetailUrl = (slug: string, code: string): string =>
  `https://${encodeURIComponent(slug)}.applytojob.com/apply/jobs/details/${encodeURIComponent(code)}`;

/** Authenticated Resumator REST endpoint for open jobs. */
export const jazzhrApiUrl = (apiKey: string): string =>
  `https://api.resumatorapi.com/v1/jobs/status/open?apikey=${encodeURIComponent(apiKey)}`;

/** Bounded concurrency for per-job detail fetches. */
export const JAZZHR_DETAIL_CONCURRENCY = 5;

/** Default headers for JazzHR career page requests. */
export const JAZZHR_HEADERS: Record<string, string> = {
  Accept: 'text/html',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};
