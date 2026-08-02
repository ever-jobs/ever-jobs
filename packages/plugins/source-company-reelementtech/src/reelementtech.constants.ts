/**
 * Constants for the ReElement Technologies (reelementtech.com) careers scraper.
 *
 * ReElement Technologies has no third-party ATS. Its careers page is a custom
 * Webflow site: `/careers` lists open roles as CMS cards, and each role is a
 * Webflow CMS collection page under `/jobs/{slug}` that server-renders the title,
 * a stated location, and a rich-text description. Applying is an on-page Webflow
 * form on the detail page (no external board, no `mailto:`, no external URL).
 *
 * This is a single-company plugin: the domain, URLs, and company name are baked
 * in. The Webflow markup is bespoke to this site, so there is no shared contract
 * to parameterize by an id.
 */

/** Canonical company display name (the brand, not the `reelementtech` domain). */
export const REELEMENTTECH_COMPANY_NAME = 'ReElement Technologies';

/** Site origin — the `www` host the site redirects to and is served from. */
export const REELEMENTTECH_ORIGIN = 'https://www.reelementtech.com';

/** Public careers landing page — also the listing fetch target (companyUrl). */
export const REELEMENTTECH_CAREERS_URL = `${REELEMENTTECH_ORIGIN}/careers`;

/** Path prefix that identifies a role collection page. */
export const REELEMENTTECH_ROLE_PATH = '/jobs/';

/** Default number of roles returned when the caller does not specify. */
export const REELEMENTTECH_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const REELEMENTTECH_DEFAULT_TIMEOUT_SECONDS = 20;

/** Bounded concurrency for the per-role detail fetches. */
export const REELEMENTTECH_DETAIL_CONCURRENCY = 6;
