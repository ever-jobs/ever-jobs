/**
 * Constants for the Spike Aerospace (spikeaerospace.com) careers scraper.
 *
 * Spike Aerospace runs no third-party ATS. Its site is WordPress (Elementor),
 * and each open role is a WordPress post filed under the "Current Openings"
 * category. Applying is an on-page form, so there is no external board, no
 * `mailto:`, and no per-role apply URL.
 *
 * The clean ingest path is the WordPress REST API: resolve the category id by
 * its slug, then read the posts in that category (title, rendered body, and
 * publish date) as structured JSON — no headless browser. The post body is then
 * parsed with Cheerio.
 *
 * This is a single-company plugin: the WordPress host and category are baked in.
 * WordPress's REST transport is uniform across sites, but the per-site content
 * model is bespoke, so there is no shared "WordPress" job schema to parameterize.
 */

/** Canonical company display name (the brand, not the `spikeaerospace` domain). */
export const SPIKEAEROSPACE_COMPANY_NAME = 'Spike Aerospace';

/** Site origin — the `www` host the site is served from. */
export const SPIKEAEROSPACE_ORIGIN = 'https://www.spikeaerospace.com';

/** Public careers landing page (used as companyUrl). */
export const SPIKEAEROSPACE_CAREERS_URL = `${SPIKEAEROSPACE_ORIGIN}/careers/`;

/** Slug of the WordPress category that holds the open roles. */
export const SPIKEAEROSPACE_OPENINGS_CATEGORY_SLUG = 'current-openings';

/**
 * Fallback category id used when the slug lookup returns nothing. Kept in sync
 * with the live "Current Openings" category so a lookup hiccup still resolves.
 */
export const SPIKEAEROSPACE_OPENINGS_CATEGORY_ID = 19;

/** Default number of roles returned when the caller does not specify. */
export const SPIKEAEROSPACE_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const SPIKEAEROSPACE_DEFAULT_TIMEOUT_SECONDS = 30;

/** WordPress REST endpoint that resolves a category by slug. */
export function spikeaerospaceCategoriesUrl(slug: string): string {
  return `${SPIKEAEROSPACE_ORIGIN}/wp-json/wp/v2/categories?slug=${encodeURIComponent(
    slug,
  )}&_fields=id,slug`;
}

/** WordPress REST endpoint for the role posts in a category. */
export function spikeaerospacePostsUrl(categoryId: number): string {
  return `${SPIKEAEROSPACE_ORIGIN}/wp-json/wp/v2/posts?categories=${categoryId}&per_page=100&orderby=date&order=desc&_fields=id,slug,link,date,title,content`;
}
