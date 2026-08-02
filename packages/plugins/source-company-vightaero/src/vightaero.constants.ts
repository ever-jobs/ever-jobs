/**
 * Constants for the Vight (vightaero.com) careers scraper.
 *
 * Vight ("private-use eVTOLs for point-to-point flight") has no third-party ATS.
 * Its careers surface is a hand-coded static site (no CMS/framework), so all role
 * text is in the server-rendered HTML: plain HTTP + Cheerio, no headless browser.
 *
 * Two-step, both on-domain:
 *   1. `/join-us/` lists open roles as `<article class="role">` cards (title,
 *      one-line copy, meta chips, and an apply link).
 *   2. Each real role's card links to an on-domain `/join-us/{slug}/` detail page
 *      that server-renders the full title, a `Location · Type · On site` meta
 *      line, the full JD sections, and an `Apply by email` link.
 *
 * The apply link on both the cards and the detail pages is a Cloudflare
 * email-protected `/cdn-cgi/l/email-protection#<hex>` anchor that decodes to
 * `join@vightaero.com` (the address is not present as plaintext). It is exposed
 * via `emails`; `applyUrl` is left unset because a `mailto:` is not a web URL.
 *
 * The "Exceptional Generalist" card has no detail page — only the card copy and
 * the same apply email; it is emitted from the listing alone.
 *
 * Single-company plugin: the domain, URLs, and company name are baked in.
 */

/** Canonical company display name. */
export const VIGHTAERO_COMPANY_NAME = 'Vight';

/** Site origin. */
export const VIGHTAERO_ORIGIN = 'https://vightaero.com';

/** Public careers page — also the listing fetch target (companyUrl). */
export const VIGHTAERO_CAREERS_URL = `${VIGHTAERO_ORIGIN}/join-us/`;

/** Path fragment that marks a Cloudflare email-protected apply link. */
export const VIGHTAERO_CF_EMAIL_PATH = '/cdn-cgi/l/email-protection';

/** Default number of roles returned when the caller does not specify. */
export const VIGHTAERO_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const VIGHTAERO_DEFAULT_TIMEOUT_SECONDS = 20;
