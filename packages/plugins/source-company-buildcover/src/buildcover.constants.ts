/**
 * Constants for the Cover (buildcover.com) careers scraper.
 *
 * Cover has no third-party ATS. Its careers content lives in a Sanity CMS and is
 * served over Sanity's unauthenticated public query API (GROQ). A single query
 * returns every `career` document plus the global apply email, so this adapter
 * needs no headless browser and no HTML parsing.
 *
 * This is a single-company plugin: the Sanity project/dataset and base URL are
 * baked in. Sanity's transport is uniform but its schema is bespoke per project,
 * so there is no shared "Sanity" contract to parameterize — a second Sanity
 * company would need its own plugin (or a future shared-helper extraction).
 */

/** Canonical company display name. */
export const BUILDCOVER_COMPANY_NAME = 'Cover';

/** Public careers page (used as companyUrl and jobUrl base). */
export const BUILDCOVER_CAREERS_URL = 'https://buildcover.com/careers/';

/** Cover's Sanity project id. */
export const BUILDCOVER_SANITY_PROJECT_ID = 'n40cnr7v';

/** Cover's Sanity dataset. */
export const BUILDCOVER_SANITY_DATASET = 'production';

/** Sanity query API version (date-pinned, per Sanity convention). */
export const BUILDCOVER_SANITY_API_VERSION = 'v2021-10-21';

/** Default number of roles returned when the caller does not specify. */
export const BUILDCOVER_DEFAULT_RESULTS = 50;

/** Default per-request timeout (seconds). */
export const BUILDCOVER_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * One GROQ query returns the global apply email and every open role. Body
 * sections stay as Portable-Text block arrays; the service renders them.
 */
export const BUILDCOVER_GROQ_QUERY = `{
  "contactEmail": *[_type=="careersPage"][0].contactEmail,
  "careers": *[_type=="career"] | order(_createdAt desc){
    _id, title, "slug": slug.current, location, type, _createdAt, _updatedAt,
    overview, role, experience, extraSections, compensation
  }
}`;

/** Section render order + labels, matching Cover's own careers UI. */
export const BUILDCOVER_SECTIONS: ReadonlyArray<{
  readonly key: 'overview' | 'role' | 'experience' | 'compensation';
  readonly label: string;
}> = [
  { key: 'overview', label: 'Overview' },
  { key: 'role', label: 'Role' },
  { key: 'experience', label: 'Experience' },
  { key: 'compensation', label: 'Compensation' },
];

/** Build Cover's Sanity public query URL for a GROQ expression. */
export function buildcoverSanityUrl(query: string): string {
  const host = `${BUILDCOVER_SANITY_PROJECT_ID}.apicdn.sanity.io`;
  const path = `/${BUILDCOVER_SANITY_API_VERSION}/data/query/${BUILDCOVER_SANITY_DATASET}`;
  return `https://${host}${path}?query=${encodeURIComponent(query)}`;
}

/** Build the public careers URL for a role slug. */
export function buildcoverJobUrl(slug: string): string {
  return `${BUILDCOVER_CAREERS_URL}${slug}/`;
}
