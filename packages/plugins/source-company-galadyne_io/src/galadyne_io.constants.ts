/**
 * Constants for the Galadyne (galadyne.io) careers scraper.
 *
 * Galadyne runs no third-party ATS. Its site is a Next.js app (Vercel). The
 * `/careers` page server-renders the opening cards (title + location), but the
 * full job descriptions are rendered client-side into an on-page overlay from a
 * hashed Next.js chunk (`.../app/careers/page-<hash>.js`) — they are not in the
 * server HTML. Applying is an on-page form that POSTs to Galadyne's own
 * `/api/careers` endpoint (no external board, no `mailto:`, no per-role URL).
 *
 * So the scraper is a two-step plain HTTP read (no headless browser):
 *   1. GET `/careers`  — enumerate the cards (title + stated location) AND read
 *      the current chunk URL straight from the page (so the content hash
 *      self-heals across deploys).
 *   2. GET the chunk    — extract the authoritative role → description map.
 *
 * The chunk holds the data as a plain object literal whose keys are the role
 * titles and whose entries carry `intro` / `responsibilities` / `qualifications`
 * / `closing`. Those property names are ordinary (unmangled) identifiers and the
 * titles are stable data, so the parse anchors on them rather than on any
 * minified variable name or hashed CSS class.
 *
 * This is a single-company plugin: the listing shape and the client data object
 * are this site's own design, so there is no shared contract to parameterize.
 */

/** Canonical company display name. */
export const GALADYNE_IO_COMPANY_NAME = 'Galadyne';

/** Site origin. */
export const GALADYNE_IO_ORIGIN = 'https://www.galadyne.io';

/** Public careers page (used as companyUrl, jobUrl, and applyUrl). */
export const GALADYNE_IO_CAREERS_URL = `${GALADYNE_IO_ORIGIN}/careers`;

/**
 * Matches the careers client chunk URL in the page HTML, e.g.
 * `/_next/static/chunks/app/careers/page-<hash>.js?dpl=<build>`. The hash and
 * build id change every deploy, so it is read from the page rather than pinned.
 */
export const GALADYNE_IO_CHUNK_HREF_RE =
  /\/_next\/static\/chunks\/app\/careers\/page-[^"'\\]+?\.js(?:\?[^"'\\]*)?/;

/** Default number of roles returned when the caller does not specify. */
export const GALADYNE_IO_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const GALADYNE_IO_DEFAULT_TIMEOUT_SECONDS = 30;
