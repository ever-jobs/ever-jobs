/**
 * Spec 5036 — AppOne JSON response shapes.
 *
 * Narrowed to the fields mapped onto `JobPostDto`. Structural interfaces (no
 * classes) so a fixture stub in the unit test only needs the JSON shape.
 * Field names are the wire shape verbatim (camelCase).
 */

/** A single posting in the list response (`companyjobposts.jobPosts[]`). */
export interface ApponeJobPost {
  readonly jobPostId?: string;
  readonly jobPostUrl?: string;
  readonly jobTitle?: string;
  /** e.g. "Full Time" / "Part Time". */
  readonly jobType?: string;
  /** e.g. "Aurora, OR". */
  readonly location?: string;
  /** ISO-8601 first-published timestamp. */
  readonly datePosted?: string;
  /** "ONSITE" | "REMOTE" | "HYBRID". */
  readonly workplaceType?: string;
}

/** `GET /api/portal/v1/companyjobposts/{tenant}` — tenant + its postings. */
export interface ApponeCompanyJobPosts {
  readonly companyName?: string;
  readonly clientId?: string;
  readonly jobPosts?: ReadonlyArray<ApponeJobPost>;
}

/**
 * `GET /api/apply/v2/jobposting/{jobPostId}` — the per-posting detail. Carries
 * the full plain-text `description` that the list omits (other fields overlap
 * the list and are only used as fallbacks).
 */
export interface ApponeJobPosting {
  readonly jobPostId?: string;
  readonly jobTitle?: string;
  readonly jobType?: string;
  readonly location?: string;
  /** Full plain-text body (newline-separated; not HTML). */
  readonly description?: string;
  readonly companyName?: string;
  readonly workplaceType?: string;
}
