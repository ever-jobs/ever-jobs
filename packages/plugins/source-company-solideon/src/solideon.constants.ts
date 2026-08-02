/**
 * Constants for the Solideon (solideon.com) careers scraper.
 *
 * Solideon runs no third-party ATS. Its site is WordPress (Elementor). The
 * `/careers/` landing page lists the open roles, each linking to its own
 * server-rendered detail page at the site root (e.g. `/solideon-<slug>/`) that
 * carries the full job description plus a per-role "Salary Recommendation",
 * "Location", and (via WordPress) a publish date. Applying is an on-page
 * Paperform embed on each detail page — there is no external board, no
 * `mailto:`, and no per-role apply URL beyond the detail page itself.
 *
 * The pages are server-rendered plain HTML (HTTP 200; Cloudflare-fronted but no
 * JS challenge), so the roles are read with a plain HTTP GET + Cheerio — no
 * headless browser.
 *
 * This is a single-company plugin: the listing shape and detail-page layout are
 * this site's own design, so there is no shared contract to parameterize.
 */

/** Canonical company display name. */
export const SOLIDEON_COMPANY_NAME = 'Solideon';

/** Site origin. */
export const SOLIDEON_ORIGIN = 'https://solideon.com';

/** Public careers landing page (used as companyUrl). */
export const SOLIDEON_CAREERS_URL = `${SOLIDEON_ORIGIN}/careers/`;

/**
 * Matches a role detail-page URL: `https://solideon.com/solideon-<slug>/`.
 * The listing links each opening to one of these; the shared "General Career
 * Interest" form is not one of them, so it is excluded by construction.
 */
export const SOLIDEON_ROLE_HREF_RE =
  /^https?:\/\/solideon\.com\/solideon-[a-z0-9-]+\/?$/i;

/** Default number of roles returned when the caller does not specify. */
export const SOLIDEON_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const SOLIDEON_DEFAULT_TIMEOUT_SECONDS = 30;
