/**
 * Constants for the Velontra (velontra.com) careers scraper.
 *
 * Velontra runs no third-party ATS. Its careers page is WordPress (Beaver
 * Builder) and lists every open role inline on `/careers/` inside collapsible
 * accordion items — each item's panel holds the full Description /
 * Responsibilities / Qualifications prose. There is no per-role page, no PDF,
 * and no per-role apply URL: applying goes through one shared application form
 * at `/apply/` (a WPForms form with a role dropdown).
 *
 * The page is server-rendered plain HTML (no Cloudflare, no JS challenge), so
 * the roles are read with a plain HTTP GET + Cheerio — no headless browser.
 *
 * This is a single-company plugin: the accordion markup + shared form are this
 * site's own design, so there is no shared contract to parameterize by an id.
 */

/** Canonical company display name. */
export const VELONTRA_COMPANY_NAME = 'Velontra';

/** Site origin. */
export const VELONTRA_ORIGIN = 'https://velontra.com';

/** Public careers landing page (roles live here; used as companyUrl + jobUrl). */
export const VELONTRA_CAREERS_URL = `${VELONTRA_ORIGIN}/careers/`;

/** Shared application form (all roles apply here — no per-role apply URL). */
export const VELONTRA_APPLY_URL = `${VELONTRA_ORIGIN}/apply/`;

/** Default number of roles returned when the caller does not specify. */
export const VELONTRA_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const VELONTRA_DEFAULT_TIMEOUT_SECONDS = 30;
