/** A role link enumerated from the `/careers` board. */
export interface ReelementtechOpening {
  /** Collection slug (last path segment of `/jobs/{slug}`). */
  slug: string;
  /** Absolute role page URL (jobUrl). */
  jobUrl: string;
  /** Role title from the listing card. */
  title: string;
  /** Stated location from the listing card, e.g. `Marion, IN` (null if absent). */
  location: string | null;
}

/** Fields parsed from a role's detail page. */
export interface ReelementtechDetail {
  /** Role title from the detail page (falls back to the listing title). */
  title: string | null;
  /** Rendered rich-text description (markdown). */
  description: string | null;
  /** Stated location from the detail page (falls back to the listing location). */
  location: string | null;
}
