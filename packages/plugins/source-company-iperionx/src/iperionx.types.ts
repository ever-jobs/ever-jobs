/**
 * A role parsed from the `/careers/` summary board. Everything the site shows
 * is on this single page — there is no detail page to fetch (the "detail" is an
 * off-site Indeed listing that is intentionally not scraped).
 */
export interface IperionxOpening {
  /** Indeed job slug (last path segment of `/job/{slug}`), used for the id. */
  slug: string;
  /** Role title as displayed, with any trailing " - {location}" removed. */
  title: string;
  /** Off-site apply/job URL (an Indeed job page; never fetched). */
  applyUrl: string;
  /** Stated location from the title suffix (e.g. `Virginia`), null if absent. */
  location: string | null;
  /** Short summary blurb rendered to markdown (null if none). */
  description: string | null;
}
