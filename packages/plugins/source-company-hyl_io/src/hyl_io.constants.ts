/**
 * Constants for the Hylio (hyl.io) careers scraper.
 *
 * Hylio has no third-party ATS. Its careers page is a custom Webflow site:
 * `/hiring/job-board` (301 `hyl.io` -> `www.hyl.io`) lists open roles as Webflow
 * CMS cards, and each role has a Webflow CMS detail page under `/hiring/{slug}`
 * that server-renders the full job description (About / Job Summary /
 * Responsibilities / Qualifications / Other), plus a `Job Type:` and `Pay:` line.
 *
 * Applying happens on **Indeed** — every card links out to an `indeed.com` URL.
 * Indeed is treated as an apply destination only: it is stored as `applyUrl` and
 * is NEVER fetched or scraped (not as a source, not during parsing). The job's
 * own on-domain detail page is the canonical `jobUrl`.
 *
 * The site states no per-role location (only "in-person" free text in the body,
 * which nothing parses), so `location` is left null — the corporate HQ is never
 * synthesized as a job location.
 *
 * Single-company plugin: the domain, URLs, and company name are baked in. The
 * Webflow markup is bespoke to this site, so there is no shared contract to
 * parameterize by an id.
 */

/** Canonical company display name (the brand, not the `hyl.io` domain). */
export const HYL_IO_COMPANY_NAME = 'Hylio';

/** Site origin — the `www` host the site redirects to and is served from. */
export const HYL_IO_ORIGIN = 'https://www.hyl.io';

/** Public careers landing page — also the listing fetch target (companyUrl). */
export const HYL_IO_CAREERS_URL = `${HYL_IO_ORIGIN}/hiring/job-board`;

/** Path prefix that identifies a role detail page under the careers section. */
export const HYL_IO_ROLE_PATH = '/hiring/';

/** Slug of the board index itself — excluded when enumerating role detail links. */
export const HYL_IO_BOARD_SLUG = 'job-board';

/** Default number of roles returned when the caller does not specify. */
export const HYL_IO_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const HYL_IO_DEFAULT_TIMEOUT_SECONDS = 20;
