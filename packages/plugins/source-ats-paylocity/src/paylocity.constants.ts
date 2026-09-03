/**
 * Paylocity recruiting URLs.
 *
 * Spec 5020 — the JSON feed endpoint (`/recruiting/api/feed/jobs/{slug}`) is
 * disabled/partner-gated and returns 5xx/4xx for every company. The reliable,
 * server-rendered source is the public board page (jobs embedded as
 * `window.pageData`) plus a per-job detail page for the full description.
 * Both are keyed by the company **GUID** (the `companySlug`).
 */

/** Paylocity recruiting host root. */
export const PAYLOCITY_BASE = 'https://recruiting.paylocity.com/recruiting/jobs';

/**
 * Board page listing all jobs for a company GUID. Returns HTML with
 * `window.pageData = { ModuleTitle, Jobs: [...] }`. The trailing label segment
 * is optional, so it is omitted.
 */
export function paylocityBoardUrl(guid: string): string {
  return `${PAYLOCITY_BASE}/All/${encodeURIComponent(guid)}`;
}

/**
 * Per-job detail page. Both the JobId and the company GUID are required (JobId
 * alone returns HTTP 500). Returns HTML with the full description + Job Type.
 */
export function paylocityDetailUrl(guid: string, jobId: string | number): string {
  return `${PAYLOCITY_BASE}/Details/${encodeURIComponent(String(jobId))}/${encodeURIComponent(guid)}`;
}

/**
 * Serialize per-job detail fetches. Paylocity detail pages throttle concurrent
 * requests with HTTP 429 + Retry-After: 30; sequential fetches complete in ~13 s
 * for a 60-job board without hitting the rate limit.
 */
export const PAYLOCITY_DETAIL_CONCURRENCY = 1;

/** Browser-like headers; the board/detail pages are HTML, not JSON. */
export const PAYLOCITY_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};
