/** A role enumerated from the `/hiring/job-board` listing. */
export interface HylIoOpening {
  /** Detail slug (last path segment of `/hiring/{slug}`). */
  slug: string;
  /** Absolute on-domain detail page URL (jobUrl); null if the card has no detail link. */
  detailUrl: string | null;
  /** Absolute Indeed apply URL (applyUrl) — link only, never fetched. */
  applyUrl: string | null;
  /** Role title from the listing card. */
  title: string;
}

/** Fields parsed from a role's on-domain detail page. */
export interface HylIoDetail {
  /** Role title from the detail `<h1>` (falls back to the listing title). */
  title: string | null;
  /** Rendered job-description body (markdown). */
  description: string | null;
  /** Stated employment type from the `Job Type:` line, e.g. `Full-time` (null if absent). */
  employmentType: string | null;
  /** Pay text lifted from the `Pay:` line, e.g. `$16.00 - $20.00 per hour` (null if absent). */
  payText: string | null;
}
