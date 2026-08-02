/** A role enumerated from the `/join-us/` listing. */
export interface VightaeroOpening {
  /** Stable slug from the card's `id` (e.g. `gnc`, `exceptional-generalist`). */
  slug: string;
  /** Card title (`h2.role-title`). Fallback for the detail-page title. */
  title: string;
  /** One-line card copy (`p.role-copy`). Fallback description (used for the generalist). */
  copy: string | null;
  /** Location chip from the card meta, e.g. `SF Bay Area, CA` (null if none). */
  locationText: string | null;
  /** Employment chip from the card meta, e.g. `Full time` (null if none). */
  employmentText: string | null;
  /** Absolute on-domain `/join-us/{slug}/` detail URL, or null (generalist has none). */
  detailUrl: string | null;
  /** Apply email decoded from the card's apply link, or null. */
  email: string | null;
}

/** Fields parsed from a role's on-domain `/join-us/{slug}/` detail page. */
export interface VightaeroDetail {
  /** Role title from the detail `<h1>` (can differ from the card title). */
  title: string | null;
  /** Location string from the detail `.meta` line (null if absent). */
  locationText: string | null;
  /** Employment string from the detail `.meta` line (null if absent). */
  employmentText: string | null;
  /** Rendered job-description body (markdown), or null if no sections were found. */
  description: string | null;
  /** Apply email decoded from the detail apply link, or null. */
  email: string | null;
}
