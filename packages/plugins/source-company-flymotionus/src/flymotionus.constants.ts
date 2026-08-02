/**
 * Constants for the FLYMOTION (flymotionus.com) careers scraper.
 *
 * FLYMOTION has no third-party ATS. Its careers page is a custom Webflow site:
 * `/careers` (301 -> `www.flymotionus.com/company/careers`) lists open roles as
 * Webflow CMS cards, and each role is a Webflow CMS collection page under
 * `/jobs/{slug}` that server-renders the title, structured detail cards (Job
 * Type, Location, Posted), and a rich-text description. Applying is an embedded
 * HubSpot form on the detail page (not an ATS/board API), so there is nothing to
 * route to a shared reader.
 *
 * Single-company plugin: the domain, URLs, and company name are baked in. The
 * Webflow markup is bespoke to this site, so there is no shared contract to
 * parameterize by an id.
 */

/** Canonical company display name (the brand, not the `flymotion` domain). */
export const FLYMOTIONUS_COMPANY_NAME = 'FLYMOTION';

/** Site origin — the `www` host the site redirects to and is served from. */
export const FLYMOTIONUS_ORIGIN = 'https://www.flymotionus.com';

/** Public careers landing page — also the listing fetch target (companyUrl). */
export const FLYMOTIONUS_CAREERS_URL = `${FLYMOTIONUS_ORIGIN}/company/careers`;

/** Path prefix that identifies a role collection page. */
export const FLYMOTIONUS_ROLE_PATH = '/jobs/';

/** Default number of roles returned when the caller does not specify. */
export const FLYMOTIONUS_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const FLYMOTIONUS_DEFAULT_TIMEOUT_SECONDS = 20;
