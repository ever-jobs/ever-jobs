import { CompensationInterval } from '@ever-jobs/models';

/**
 * Constants for the Avalanche Energy (avalanchefusion.com) careers scraper.
 *
 * Avalanche Energy has no third-party ATS. Its careers page is a custom Webflow
 * site: the board lists open roles, and each role is a Webflow CMS collection
 * page under `/careers/open-position/{slug}` that server-renders the title, a
 * structured "Salary Range" block, and a rich-text description. The "Apply"
 * button links out to a LinkedIn job posting (there is no on-site form or email).
 *
 * This is a single-company plugin: the domain, URLs, and company name are baked
 * in. The Webflow markup is bespoke to this site, so there is no shared contract
 * to parameterize by an id.
 */

/** Canonical company display name (the brand, not the `avalanchefusion` domain). */
export const AVALANCHEFUSION_COMPANY_NAME = 'Avalanche Energy';

/** Site origin — the `www` host the site is served from. */
export const AVALANCHEFUSION_ORIGIN = 'https://www.avalanchefusion.com';

/** Public careers landing page (used as companyUrl). */
export const AVALANCHEFUSION_CAREERS_URL = `${AVALANCHEFUSION_ORIGIN}/careers`;

/** The open-positions board — the listing fetch target. */
export const AVALANCHEFUSION_LISTING_URL = `${AVALANCHEFUSION_ORIGIN}/careers/open-positions`;

/** Path prefix that identifies a role collection page. */
export const AVALANCHEFUSION_ROLE_PATH = '/careers/open-position/';

/**
 * Default job location. Roles rarely carry a structured location; the company
 * is based in the Seattle, WA metro (its sites are in Tukwila, WA). A role that
 * states a `Sites:` line in its body overrides this.
 */
export const AVALANCHEFUSION_DEFAULT_LOCATION = 'Seattle, WA';

/** Default number of roles returned when the caller does not specify. */
export const AVALANCHEFUSION_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const AVALANCHEFUSION_DEFAULT_TIMEOUT_SECONDS = 20;

/** Bounded concurrency for the per-role detail fetches. */
export const AVALANCHEFUSION_DETAIL_CONCURRENCY = 6;

/**
 * Per-unit pay tokens that may appear in a role's Salary Range, mapped to the
 * canonical interval. Ordered most-specific first; the first match wins. All
 * current roles publish a yearly (`/yr`) rate, but the token is read rather than
 * assumed so an hourly role would still be correct.
 */
export const AVALANCHEFUSION_PAY_INTERVALS: ReadonlyArray<
  readonly [RegExp, CompensationInterval]
> = [
  [/(?:\/\s*(?:hr|hrs|hour)|per\s+hour|hourly)\b/i, CompensationInterval.HOURLY],
  [/(?:\/\s*day|per\s+day|daily)\b/i, CompensationInterval.DAILY],
  [/(?:\/\s*(?:wk|week)|per\s+week|weekly)\b/i, CompensationInterval.WEEKLY],
  [/(?:\/\s*(?:mo|month)|per\s+month|monthly)\b/i, CompensationInterval.MONTHLY],
  [
    /(?:\/\s*(?:yr|year)|per\s+(?:year|annum)|yearly|annually)\b/i,
    CompensationInterval.YEARLY,
  ],
];
