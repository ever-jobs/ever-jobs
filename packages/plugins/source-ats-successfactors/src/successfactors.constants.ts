/**
 * SAP SuccessFactors exposes the same requisitions through more than one surface.
 * This plugin reads whichever one a given employer actually publishes:
 *
 * Company slug format: {instance}:{companyId}
 * e.g., "sap:SAP" or "career4:C<companyId>P"
 *
 * 1. OData API (structured, preferred when open):
 *      https://{instance}.successfactors.com/odata/v2/JobRequisitionPosting
 *      Supports $filter, $select, $top, $skip, $orderby params.
 *
 * 2. Career Site Builder (CSB) / Recruiting Marketing (RMK) site — a
 *    server-rendered careers portal, frequently on the employer's OWN custom
 *    domain (e.g. `careers.example.com`) with no `successfactors` in the
 *    hostname. Many tenants do not enable public OData, so this is the only
 *    public surface. Addressed by the portal URL (`companyUrl`), not the
 *    instance subdomain:
 *      list:   {base}/tile-search-results/?q=&sortColumn=referencedate&sortDirection=desc&startrow={N}
 *      detail: {base}/job/{Location-Title-State}/{jobId}/  (schema.org JobPosting *microdata*)
 *
 * 3. Native careersection HTML (last-resort fallback):
 *      https://{instance}.successfactors.com/career?company={companyId}&keyword={term}
 *
 * Selection is deterministic: OData first (when an instance is known); if it
 * yields nothing, the CSB reader runs when a portal URL is available; the native
 * careersection HTML is the final fallback.
 */

/** Default page size for SuccessFactors OData pagination */
export const SF_PAGE_SIZE = 20;

/** Minimum delay between SuccessFactors requests (ms) */
export const SF_DELAY_MIN = 1500;

/** Maximum delay between SuccessFactors requests (ms) */
export const SF_DELAY_MAX = 3000;

/** Default headers for SuccessFactors API requests */
export const SF_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/**
 * Parse a SuccessFactors compound slug into its components.
 * Format: "{instance}:{companyId}"
 * Defaults: companyId = instance name
 */
export function parseSfSlug(slug: string): {
  instance: string;
  companyId: string;
} {
  const parts = slug.split(':');
  return {
    instance: parts[0],
    companyId: parts[1] ?? parts[0],
  };
}

/**
 * Build the SuccessFactors OData API URL for a given instance.
 */
export function buildSfODataUrl(instance: string): string {
  return `https://${instance}.successfactors.com/odata/v2/JobRequisitionPosting`;
}

/**
 * Build the SuccessFactors HTML career page URL.
 */
export function buildSfCareerUrl(
  instance: string,
  companyId: string,
  keyword?: string,
): string {
  let url = `https://${instance}.successfactors.com/career?company=${encodeURIComponent(companyId)}`;
  if (keyword) {
    url += `&keyword=${encodeURIComponent(keyword)}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Career Site Builder (CSB / RMK) reader
// ---------------------------------------------------------------------------

/** Job tiles returned per CSB `tile-search-results` page. */
export const SF_CSB_PAGE_SIZE = 25;

/** Hard cap on CSB tile pages walked per scrape (safety bound). */
export const SF_CSB_MAX_PAGES = 40;

/** Bounded concurrency for CSB detail-page fan-out. */
export const SF_CSB_DETAIL_CONCURRENCY = 5;

/**
 * Content fingerprints that identify a Career Site Builder page even when the
 * hostname is a custom domain with no `successfactors` in it. Used to confirm a
 * careers portal is SuccessFactors-backed before routing it to the CSB reader.
 */
export const SF_CSB_FINGERPRINTS: readonly string[] = [
  '/tile-search-results/',
  'jobtitle-link',
  '/platform/bootstrap/',
  'data-careersite-propertyid',
  'careersite',
] as const;

/** Native SuccessFactors instance fingerprint (`careerN.successfactors.com`). */
export const SF_INSTANCE_RE = /career\d*\.successfactors\.com/i;

/** Native SuccessFactors company-id fingerprint (`company=C<digits>P`). */
export const SF_COMPANY_ID_RE = /company=(C\d+P)/i;

/**
 * Extract the numeric job id from a CSB detail path: `/job/{slug}/{jobId}/`.
 * Group 1 is the job id.
 */
export const SF_CSB_JOB_LINK_RE = /\/job\/[^"'#?\s]+?\/(\d+)\/?(?:[?#]|$)/i;

/**
 * True when the HTML looks like a SuccessFactors Career Site Builder portal.
 * Requires at least two independent fingerprints to avoid false positives.
 */
export function htmlLooksLikeCsb(html: string): boolean {
  if (!html) return false;
  const lower = html.toLowerCase();
  let hits = 0;
  for (const fp of SF_CSB_FINGERPRINTS) {
    if (lower.includes(fp)) hits += 1;
    if (hits >= 2) return true;
  }
  return SF_INSTANCE_RE.test(html) && hits >= 1;
}

/**
 * Resolve the CSB portal origin (scheme + host) from a career portal URL.
 * Returns null when the input is missing or not an absolute http(s) URL.
 */
export function resolveCsbBaseUrl(companyUrl?: string): string | null {
  if (!companyUrl) return null;
  const raw = companyUrl.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Build a CSB `tile-search-results` list URL for a given portal origin and
 * pagination offset. `keyword` maps to the portal's `q` search param.
 */
export function buildSfCsbTileUrl(
  base: string,
  startrow: number,
  keyword?: string,
): string {
  const params = new URLSearchParams({
    q: keyword ?? '',
    sortColumn: 'referencedate',
    sortDirection: 'desc',
    startrow: String(startrow),
  });
  return `${base.replace(/\/$/, '')}/tile-search-results/?${params.toString()}`;
}
