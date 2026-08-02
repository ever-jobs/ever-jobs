/**
 * Constants for the NANO Nuclear Energy (nanonuclearenergy.com) careers scraper.
 *
 * NANO runs no third-party ATS. Its careers page is a WordPress site built with
 * the Divi page builder: the roles are hand-authored Divi "blurb" modules and
 * applying is an on-page WordPress (WPForms) form — there is no external board,
 * no `mailto:`, and no per-role apply URL.
 *
 * The clean ingest path is the WordPress REST API, which returns the page's
 * server-rendered HTML (`content.rendered`) as structured JSON, so this adapter
 * needs no headless browser. The Divi block markup is then parsed with Cheerio.
 *
 * This is a single-company plugin: the WordPress host and page slug are baked
 * in. WordPress's REST transport is uniform across sites, but the per-site
 * content model is bespoke (Divi blurbs here; the WP Job Manager plugin, custom
 * post types, or other builders elsewhere), so there is no shared "WordPress"
 * job schema to parameterize — a different WordPress company would need its own
 * plugin.
 */

/** Canonical company display name. */
export const NANONUCLEARENERGY_COMPANY_NAME = 'NANO Nuclear Energy';

/** Public careers page (used as companyUrl and jobUrl). */
export const NANONUCLEARENERGY_CAREERS_URL =
  'https://nanonuclearenergy.com/careers/';

/** WordPress host serving the REST API. */
export const NANONUCLEARENERGY_WP_HOST = 'https://nanonuclearenergy.com';

/** Slug of the careers page (resolved to its rendered content via the REST API). */
export const NANONUCLEARENERGY_CAREERS_SLUG = 'careers';

/** All roles are salaried annual bases, stated as `Salary: $min - $max`. */
export const NANONUCLEARENERGY_SALARY_LABEL = 'Salary';

/** Default number of roles returned when the caller does not specify. */
export const NANONUCLEARENERGY_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const NANONUCLEARENERGY_DEFAULT_TIMEOUT_SECONDS = 30;

/** WordPress REST endpoint for the careers page, keyed by slug. */
export function nanonuclearenergyPagesUrl(slug: string): string {
  return `${NANONUCLEARENERGY_WP_HOST}/wp-json/wp/v2/pages?slug=${encodeURIComponent(
    slug,
  )}`;
}
