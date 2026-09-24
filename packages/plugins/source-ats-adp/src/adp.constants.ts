/**
 * ADP Workforce Now is served from more than one host: the same `cid` resolves
 * on either `workforcenow.adp.com` or `workforcenow.cloud.adp.com`, and a given
 * company lives on exactly one of them (the other returns HTTP 404). The plugin
 * tries them in order and keeps whichever answers.
 */
export const ADP_HOSTS = [
  'workforcenow.adp.com',
  'workforcenow.cloud.adp.com',
] as const;

/** Path of the public career-center staffing API (host prepended at runtime). */
const ADP_API_PATH =
  '/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';

/** Path of the human-facing recruitment career center (host prepended at runtime). */
const ADP_RECRUITMENT_PATH =
  '/mascsr/default/mdf/recruitment/recruitment.html';

/**
 * Build the requisition-list endpoint for a host + company `cid`. The API
 * caps each response at 20 requisitions (`meta.totalNumber` reports the real
 * total); pages are addressed with `$skip`/`$top`.
 */
export function adpListUrl(host: string, cid: string, skip = 0): string {
  const base =
    `https://${host}${ADP_API_PATH}?cid=${encodeURIComponent(cid)}`;
  return skip > 0 ? `${base}&$skip=${skip}&$top=${ADP_PAGE_SIZE}` : base;
}

/** ADP's server-enforced list page size (`$top` above it is ignored). */
export const ADP_PAGE_SIZE = 20;

/**
 * Env var capping how many requisition-list pages (first page included) one
 * scrape may fetch. A politeness / safety bound on top of the resultsWanted
 * early stop. `1` restores the pre-pagination behaviour (first page only).
 */
export const ADP_MAX_LIST_PAGES_ENV = 'ADP_MAX_LIST_PAGES';

/** Default list-page cap: 100 pages × 20 = 2,000 requisitions. */
export const ADP_DEFAULT_MAX_LIST_PAGES = 100;

/**
 * Parse a raw `ADP_MAX_LIST_PAGES` value. Unset/blank → the default; a
 * positive integer → that cap; anything else → null so the caller can warn
 * and fall back to the default.
 */
export function parseAdpMaxListPages(raw: string | null | undefined): number | null {
  const v = (raw ?? '').trim();
  if (!v) return ADP_DEFAULT_MAX_LIST_PAGES;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Build the per-requisition detail endpoint for a host + company `cid`. The list
 * feed omits the posting body; `requisitionDescription` lives only here.
 */
export function adpDetailUrl(host: string, cid: string, itemId: string): string {
  return `https://${host}${ADP_API_PATH}/${encodeURIComponent(itemId)}?cid=${encodeURIComponent(cid)}`;
}

/** Build the public, human-facing career-center URL for a single requisition. */
export function adpCareersUrl(host: string, cid: string, itemId: string): string {
  return (
    `https://${host}${ADP_RECRUITMENT_PATH}` +
    `?cid=${encodeURIComponent(cid)}` +
    `&selectedMenuKey=CurrentOpenings` +
    `&jobId=${encodeURIComponent(itemId)}`
  );
}

/** Bounded concurrency for per-requisition detail fetches. */
export const ADP_DETAIL_CONCURRENCY = 5;

/** Default headers for ADP career site requests */
export const ADP_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};
