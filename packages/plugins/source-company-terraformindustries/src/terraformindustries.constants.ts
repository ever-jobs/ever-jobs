/**
 * Constants for the Terraform Industries careers scraper.
 *
 * Terraform Industries has no third-party ATS. Its careers listings live in a
 * "Careers" section on the company home page (`terraformindustries.com`) as a
 * flat list of `<a>` links, one per role, each pointing at a Google Doc that
 * holds the full job description. This adapter enumerates those links, then
 * fetches each Google Doc's plain-text export to enrich the role with its
 * location and description.
 */

/** Company home page carrying the Careers list. */
export const TERRAFORMINDUSTRIES_CAREERS_URL = 'https://terraformindustries.com/';

/** Canonical company display name. */
export const TERRAFORMINDUSTRIES_COMPANY_NAME = 'Terraform Industries';

/** Heading that precedes the role list on the home page. */
export const TERRAFORMINDUSTRIES_CAREERS_HEADING = 'Careers';

/** Default number of roles returned when the caller does not specify. */
export const TERRAFORMINDUSTRIES_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const TERRAFORMINDUSTRIES_DEFAULT_TIMEOUT_SECONDS = 30;

/** Maximum simultaneous Google Doc detail fetches. */
export const TERRAFORMINDUSTRIES_DETAIL_CONCURRENCY = 5;

/** The domain line that separates the doc header from its body. */
export const TERRAFORMINDUSTRIES_DOC_DOMAIN_MARKER = 'terraformindustries.com';

/** Build the canonical, shareable URL for a Google Doc job description. */
export function terraformIndustriesDocUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/`;
}

/** Build the plain-text export URL for a Google Doc job description. */
export function terraformIndustriesDocExportUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/export?format=txt`;
}
