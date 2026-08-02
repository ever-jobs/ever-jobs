/** A role enumerated from the `/hiring` listing. */
export interface FrameworkCoOpening {
  /** Detail slug (last path segment of `/jobs/{slug}`). */
  slug: string;
  /** Absolute on-domain detail page URL (jobUrl). */
  detailUrl: string;
  /** Human-readable title derived from the slug (fallback for the detail title). */
  title: string;
}

/** Fields parsed from a role's on-domain `/jobs/{slug}` detail page. */
export interface FrameworkCoDetail {
  /** Role title from the detail `<title>` (falls back to the listing title). */
  title: string | null;
  /** Location string from the `Location` container, e.g. `Los Angeles, CA` (null if absent). */
  location: string | null;
  /** Salary string from the `Salary` container, e.g. `$150k-$200k+ | Generous Equity` (null if absent). */
  salaryText: string | null;
  /** Rendered job-description body (markdown), or null if no JD sections were found. */
  description: string | null;
}
