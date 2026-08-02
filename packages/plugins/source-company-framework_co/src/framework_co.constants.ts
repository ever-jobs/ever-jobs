/**
 * Constants for the Framework Automation (framework.co) careers scraper.
 *
 * Framework Automation ("building fully automated apparel manufacturing
 * facilities in the United States") has no third-party ATS. Its careers surface
 * is a custom **Framer** site (server-side generated — `server: Framer`,
 * `ssg-status: optimized`), so the role text, location, salary, and full job
 * descriptions are all present in the server-rendered HTML: plain HTTP + Cheerio,
 * no headless browser.
 *
 * Two-step, both on-domain:
 *   1. `/hiring` lists open roles, each linking to an on-domain `/jobs/{slug}`
 *      detail page.
 *   2. `/jobs/{slug}` server-renders the role's title, a `Location:` and
 *      `Salary:` line (as Framer named rich-text containers), and the full JD
 *      (as the named rich-text sections listed in
 *      {@link FRAMEWORK_CO_JD_SECTION_NAMES}).
 *
 * Applying happens through a single on-domain form at `/apply` (a native Framer
 * form with a role dropdown) — there is no per-role apply URL. So the canonical
 * `jobUrl` is the employer's own `/jobs/{slug}` detail page and `applyUrl` is the
 * shared `/apply` page. No Indeed / third-party ATS is involved anywhere.
 *
 * Single-company plugin: the domain, URLs, and company name are baked in; the
 * Framer markup is bespoke to this site, so there is no shared contract to
 * parameterize by an id.
 */

/** Canonical company display name (the brand, not the `framework.co` domain). */
export const FRAMEWORK_CO_COMPANY_NAME = 'Framework Automation';

/** Site origin. */
export const FRAMEWORK_CO_ORIGIN = 'https://framework.co';

/** Public careers landing page — also the listing fetch target (companyUrl). */
export const FRAMEWORK_CO_CAREERS_URL = `${FRAMEWORK_CO_ORIGIN}/hiring`;

/** Shared on-domain application form (applyUrl); no per-role apply URL exists. */
export const FRAMEWORK_CO_APPLY_URL = `${FRAMEWORK_CO_ORIGIN}/apply`;

/** Path prefix that identifies a role detail page. */
export const FRAMEWORK_CO_ROLE_PATH = '/jobs/';

/**
 * Framer `data-framer-name` values of the rich-text containers that hold the
 * job description on a `/jobs/{slug}` detail page, in reading order. These are
 * the CMS collection's rich-text fields and are shared across the site's roles.
 * The description is the concatenation of whichever of these are present; if the
 * template ever changes these names the description degrades to null while the
 * title / location / salary (parsed independently) still populate.
 */
export const FRAMEWORK_CO_JD_SECTION_NAMES: readonly string[] = [
  'Who we are',
  'Life at Frameworks',
  'Requirements',
];

/** Framer `data-framer-name` of the container holding the `Location:` value. */
export const FRAMEWORK_CO_LOCATION_FRAMER_NAME = 'Location';

/** Framer `data-framer-name` of the container holding the `Salary:` value. */
export const FRAMEWORK_CO_SALARY_FRAMER_NAME = 'Salary';

/** Default number of roles returned when the caller does not specify. */
export const FRAMEWORK_CO_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const FRAMEWORK_CO_DEFAULT_TIMEOUT_SECONDS = 20;
