/** A role link enumerated from the `/company/careers` board. */
export interface FlymotionusOpening {
  /** Collection slug (last path segment of `/jobs/{slug}`). */
  slug: string;
  /** Absolute role page URL (jobUrl). */
  jobUrl: string;
  /** Role title from the listing card. */
  title: string;
  /** Stated location from the listing card, e.g. `Tampa, FL` (null if absent). */
  location: string | null;
  /** Stated employment type from the listing card, e.g. `Full-Time` (null if absent). */
  employmentType: string | null;
}

/** Fields parsed from a role's detail page. */
export interface FlymotionusDetail {
  /** Role title from the detail `<h1>` (falls back to the listing title). */
  title: string | null;
  /** Rendered rich-text description (markdown). */
  description: string | null;
  /** Stated location from the detail `Location` card (falls back to the listing). */
  location: string | null;
  /** Stated employment type from the detail `Job Type` card (falls back to listing). */
  employmentType: string | null;
  /** Stated posting date from the detail `Posted` card (null if absent/unparseable). */
  datePosted: Date | null;
  /** Pay text lifted from the rich-text `Pay:` section (null if absent). */
  payText: string | null;
}
