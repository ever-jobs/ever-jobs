/**
 * Wire shapes of the Naukri search endpoint (`GET /jobapi/v3/search`), Spec 1712.
 *
 * Every field is optional: the endpoint is undocumented, so the plugin treats
 * the payload as untrusted and coerces each value where it is read.
 */

/** A labelled chip on a result card. Only these three types are read. */
export interface NaukriPlaceholder {
  type?: 'location' | 'salary' | 'experience' | string;
  label?: string | null;
}

/** AmbitionBox rating block attached to a result. */
export interface NaukriAmbitionBoxData {
  AggregateRating?: string | number | null;
  ReviewsCount?: number | string | null;
}

/** One row of `jobDetails[]`. */
export interface NaukriJobDetail {
  jobId?: string | number | null;
  title?: string | null;
  companyName?: string | null;
  /** Company page slug, relative to the site root. */
  staticUrl?: string | null;
  /** Usually a site-relative path; occasionally absolute. */
  jdURL?: string | null;
  /** Short HTML snippet. */
  jobDescription?: string | null;
  placeholders?: NaukriPlaceholder[] | null;
  /** `Today`, `Just Now`, `Few Hours Ago`, `3 Days Ago`, `30+ Days Ago`. */
  footerPlaceholderLabel?: string | null;
  /** Epoch milliseconds. */
  createdDate?: number | string | null;
  /** Comma-separated skills. */
  tagsAndSkills?: string | null;
  experienceText?: string | null;
  ambitionBoxData?: NaukriAmbitionBoxData | null;
  /** Openings; `0` means unspecified. */
  vacancy?: number | string | null;
  logoPathV3?: string | null;
  logoPath?: string | null;
}

/**
 * Search response. On refusal the board answers `406` with
 * `{ "message": "recaptcha required", "statusCode": 406 }`, which is why
 * `message` and `statusCode` are part of the shape.
 */
export interface NaukriSearchResponse {
  jobDetails?: NaukriJobDetail[] | null;
  /** Total hits. Unverified: used only as an optional stop hint. */
  noOfJobs?: number | string | null;
  message?: string | null;
  statusCode?: number | null;
}
