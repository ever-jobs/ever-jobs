/**
 * YC Work at a Startup (WaaS) URLs.
 *
 * Spec 5023 — WaaS is a multi-tenant ATS exposed under two hosts for the same
 * underlying board:
 *   canonical: https://www.workatastartup.com/companies/{slug}        (no /jobs)
 *   mirror:    https://www.ycombinator.com/companies/{slug}/jobs       (with /jobs)
 *
 * The **YC mirror is the data source**: the canonical WaaS board is thin and
 * auth-gated, whereas the YC company jobs page embeds an Inertia.js `data-page`
 * blob enumerating every opening (`props.jobPostings[]`), and each YC per-job
 * detail page carries a schema.org `JobPosting` ld+json block. The canonical
 * `workatastartup.com/companies/{slug}` URL is used only for `companyUrl`
 * (source-of-truth identity); harvesting always goes through the YC mirror.
 */

/** Canonical Work at a Startup host (source-of-truth identity). */
export const WAAS_CANONICAL_BASE = 'https://www.workatastartup.com';

/** Public YC mirror host (the harvestable face). */
export const WAAS_YC_BASE = 'https://www.ycombinator.com';

/** Public YC company jobs page (the list spine). Note the `/jobs` suffix. */
export function waasCompanyJobsUrl(slug: string): string {
  return `${WAAS_YC_BASE}/companies/${encodeURIComponent(slug)}/jobs`;
}

/** Canonical Work at a Startup company page (used for `companyUrl`). */
export function waasCanonicalCompanyUrl(slug: string): string {
  return `${WAAS_CANONICAL_BASE}/companies/${encodeURIComponent(slug)}`;
}

/**
 * Resolve a job's (relative) detail `url` against the YC host. The Inertia blob
 * carries paths like `/companies/{slug}/jobs/{id}-{job-slug}`.
 */
export function waasDetailUrl(jobUrlPath: string): string {
  if (/^https?:\/\//i.test(jobUrlPath)) return jobUrlPath;
  const path = jobUrlPath.startsWith('/') ? jobUrlPath : `/${jobUrlPath}`;
  return `${WAAS_YC_BASE}${path}`;
}

/** Bounded concurrency for the per-job detail (ld+json) overlay fetch. */
export const WAAS_DETAIL_CONCURRENCY = 5;

/**
 * Hard cap on jobs harvested per company, a safety valve independent of
 * `resultsWanted`. No YC company board approaches this.
 */
export const WAAS_MAX_RESULTS = 200;

/** YC mirror serves HTML; request as a browser would. */
export const WAAS_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};
