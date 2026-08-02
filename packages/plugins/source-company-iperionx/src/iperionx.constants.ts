/**
 * Constants for the IperionX (iperionx.com) careers scraper.
 *
 * IperionX has no third-party ATS. Its careers page is a custom WordPress page
 * that lists open roles as a **summary only**: each role shows just a title, a
 * one-or-two-sentence blurb, and an "Apply Now" button that links out to an
 * Indeed job page. The full job detail lives on Indeed and is deliberately out
 * of scope — this plugin never fetches Indeed; the Indeed URL is used only as
 * the apply/job link. Consequently many fields are intentionally left empty
 * (no salary, no posted date, no employment type are stated on-site).
 *
 * This is a single-company plugin: the domain, URL, and company name are baked
 * in. The markup is bespoke to this site, so there is no shared contract to
 * parameterize by an id.
 */

/** Canonical company display name (the brand, not the `iperionx` domain). */
export const IPERIONX_COMPANY_NAME = 'IperionX';

/** Site origin. */
export const IPERIONX_ORIGIN = 'https://iperionx.com';

/** Public careers page — also the listing fetch target (companyUrl). */
export const IPERIONX_CAREERS_URL = `${IPERIONX_ORIGIN}/careers/`;

/**
 * Substring that identifies a role's off-site apply link. Applying happens on
 * Indeed; that link is used only as the job/apply URL and is never fetched.
 */
export const IPERIONX_APPLY_LINK_MATCH = 'indeed.com/job/';

/** Path segment preceding an Indeed job slug (`/job/{slug}`). */
export const IPERIONX_INDEED_JOB_PATH = '/job/';

/** Default number of roles returned when the caller does not specify. */
export const IPERIONX_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const IPERIONX_DEFAULT_TIMEOUT_SECONDS = 20;
