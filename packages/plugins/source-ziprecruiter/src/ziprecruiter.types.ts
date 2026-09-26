/**
 * Response contract of the ZipRecruiter jobs-app search endpoint (Spec 1713 section 4).
 *
 * Every field is optional: the endpoint is not a documented public API, so the
 * mapper treats each one as possibly absent and never throws on a missing key.
 * A few names from the retired partner API (`job_id`, `id`, `salary_*_annual`,
 * `continue_token`, `job_url`, `url`) are still read, but only as fallbacks.
 */

export interface ZipHiringCompany {
  name?: string | null;
  url?: string | null;
  logo?: string | null;
}

export interface ZipJob {
  /** Stable listing id. Also builds the public job URL. */
  listing_key?: string | null;
  /** Retired partner-API ids, used only when `listing_key` is absent. */
  job_id?: string | number | null;
  id?: string | number | null;

  name?: string | null;
  title?: string | null;
  /** HTML body from the list payload. */
  job_description?: string | null;
  snippet?: string | null;

  hiring_company?: ZipHiringCompany | null;

  job_city?: string | null;
  job_state?: string | null;
  /** `US` or `CA`. A bare `CA` is Canada here, never California. */
  job_country?: string | null;

  /** e.g. `full_time`, `part_time`, `contractor`. */
  employment_type?: string | null;
  /** ISO-8601 instant with `Z`. */
  posted_time?: string | null;

  compensation_min?: number | string | null;
  compensation_max?: number | string | null;
  /** e.g. `annual`, `hourly`. */
  compensation_interval?: string | null;
  /** `USD` or `CAD`. */
  compensation_currency?: string | null;
  /** Retired partner-API salary fields (annual USD), read only as a fallback. */
  salary_min_annual?: number | null;
  salary_max_annual?: number | null;

  /** Boolean on the app contract; some payloads carry the string `'true'`. */
  remote?: boolean | string | null;
  /** Listing type: organic, sponsored, ... */
  buyer_type?: string | null;

  /** Retired partner-API links, used only when `listing_key` is absent. */
  job_url?: string | null;
  url?: string | null;

  /** Direct apply link, when the list payload carries one. */
  apply_url?: string | null;
  /** A save link whose `job_url` query parameter holds the direct apply URL. */
  save_job_url?: string | null;
}

export interface ZipJobsResponse {
  jobs?: ZipJob[] | null;
  /** Pagination token for the next page, sent back as `continue_from`. */
  continue?: string | null;
  /** Retired partner-API spelling of the token, read only as a fallback. */
  continue_token?: string | null;
}

/** Error body, e.g. `{"status_code":403,"error_code":"forbidden cf-waf","error_message":"Forbidden"}`. */
export interface ZipErrorBody {
  status_code?: number;
  error_code?: string;
  error_message?: string;
}
