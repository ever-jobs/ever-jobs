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

/** Build the requisition-list endpoint for a host + company `cid`. */
export function adpListUrl(host: string, cid: string): string {
  return `https://${host}${ADP_API_PATH}?cid=${encodeURIComponent(cid)}`;
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
