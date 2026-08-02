/**
 * TypeScript interfaces for Workable API responses.
 * Ported from ats-scrapers/models/workable.py
 */

export interface WorkableLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  hidden?: boolean | null;
}

export interface WorkableJob {
  title?: string | null;
  shortcode?: string | null;
  code?: string | null;
  employment_type?: string | null;
  telecommuting?: boolean | null;
  department?: string | null;
  url?: string | null;
  shortlink?: string | null;
  application_url?: string | null;
  published_on?: string | null;
  created_at?: string | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  education?: string | null;
  experience?: string | null;
  function?: string | null;
  industry?: string | null;
  locations?: WorkableLocation[] | null;
}

export interface WorkableResponse {
  /** Company display name (e.g. "Shift Robotics"); not the slug. */
  name?: string | null;
  jobs: WorkableJob[];
}

/**
 * Workable public per-job detail object.
 * Returned by `GET /api/v2/accounts/{slug}/jobs/{shortcode}`.
 * Carries the rich posting body and work-mode that the widget list omits.
 */
export interface WorkableJobDetail {
  shortcode?: string | null;
  description?: string | null;
  requirements?: string | null;
  benefits?: string | null;
  /** Work-mode enum: "on_site" | "hybrid" | "remote" */
  workplace?: string | null;
  remote?: boolean | null;
}

/**
 * Workable API v3 job object.
 * @see https://workable.readme.io/reference/jobs
 */
export interface WorkableApiV3Job {
  id?: string | null;
  title?: string | null;
  full_title?: string | null;
  shortcode?: string | null;
  code?: string | null;
  state?: string | null;
  department?: string | null;
  department_hierarchy?: Array<{ id?: number; name?: string }> | null;
  url?: string | null;
  application_url?: string | null;
  shortlink?: string | null;
  location?: {
    location_str?: string | null;
    country?: string | null;
    country_code?: string | null;
    region?: string | null;
    region_code?: string | null;
    city?: string | null;
    zip_code?: string | null;
    telecommuting?: boolean | null;
  } | null;
  created_at?: string | null;
  published_on?: string | null;
  employment_type?: string | null;
}

/**
 * Workable API v3 list jobs response.
 * @see https://workable.readme.io/reference/jobs
 */
export interface WorkableApiV3Response {
  jobs: WorkableApiV3Job[];
  paging?: {
    next?: string | null;
  } | null;
}
