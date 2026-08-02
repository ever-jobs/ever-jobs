/**
 * TypeScript interfaces for the Dover public careers REST surface.
 *
 * Dover exposes a tenant's open roles through an unauthenticated REST flow on
 * `app.dover.com`: resolve a board slug → careers-page client id
 * (`/api/v1/careers-page-slug/{slug}`), list the roles
 * (`/api/v1/careers-page/{clientId}/jobs`), then overlay each role's rich detail
 * (`/api/v1/inbound/application-portal-job/{jobId}`). Only the fields the adapter
 * consumes are typed; everything is optional and defensively narrowed at parse
 * time so minor cross-tenant or version drift never breaks the parser.
 */

import { CompensationDto } from '@ever-jobs/models';

/** A careers-page resolution response (`careers-page-slug` or `careers-page`). */
export interface DoverCareersPage {
  /** The careers-page client id used to list jobs. */
  id?: string | null;
  /** The tenant company display name. */
  name?: string | null;
  /** The canonical board slug. */
  slug?: string | null;
}

/** A structured location option carried on a Dover role. */
export interface DoverLocationOption {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  display_name?: string | null;
}

/** A location entry on a Dover role (list or detail). */
export interface DoverLocation {
  /** `IN_OFFICE` / `REMOTE` / `HYBRID`. */
  location_type?: string | null;
  name?: string | null;
  location_option?: DoverLocationOption | null;
}

/** The structured compensation block on a role's detail. */
export interface DoverCompensation {
  lower_bound?: number | null;
  upper_bound?: number | null;
  currency_code?: string | null;
  /** Pay period, e.g. `YEARLY` / `HOURLY`. */
  salary_range_type?: string | null;
  /** Employment type, e.g. `FULL_TIME` / `INTERNSHIP`. */
  employment_type?: string | null;
}

/** A role as carried by the careers-page jobs list. */
export interface DoverListJob {
  id?: string | null;
  title?: string | null;
  /** `ONSITE` / `REMOTE` / `HYBRID`. */
  workplace_type?: string | null;
  locations?: DoverLocation[] | null;
  is_published?: boolean | null;
  /** Demo/sample roles Dover seeds onto empty boards; excluded from results. */
  is_sample?: boolean | null;
}

/** The careers-page jobs-list envelope (paged). */
export interface DoverJobsResponse {
  count?: number | null;
  next?: string | null;
  previous?: string | null;
  results?: DoverListJob[] | null;
}

/** A role's detail from `application-portal-job/{id}`. */
export interface DoverJobDetail {
  id?: string | null;
  /** Tenant company display name (the real name — never the slug). */
  client_name?: string | null;
  title?: string | null;
  /** Full job-ad body, as HTML. */
  user_provided_description?: string | null;
  /** Single free-text location label fallback. */
  location?: string | null;
  locations?: DoverLocation[] | null;
  workplace_type?: string | null;
  /** Role creation timestamp — used as the posted date. */
  created?: string | null;
  /** Posted date when the payload advertises one directly. */
  date_posted?: string | null;
  compensation?: DoverCompensation | null;
}

/**
 * Normalised view of a single Dover role, assembled from a list job overlaid
 * with its detail.
 */
export interface DoverJob {
  /** Role id — used as the ATS id. */
  jobId: string;
  /** Absolute public board URL. */
  url: string;
  /** Job display title. */
  title: string | null;
  /** Tenant company display name (from `client_name` / careers-page `name`). */
  companyName: string | null;
  /** Full job-ad body as HTML. */
  descriptionHtml: string | null;
  /** Structured location parts. */
  city: string | null;
  state: string | null;
  country: string | null;
  /** Employment-type label, when present. */
  employmentType: string | null;
  /** Posted date — parsed to `YYYY-MM-DD`. */
  datePosted: string | null;
  /** True when the role advertises remote / distributed working. */
  isRemote: boolean;
  /** Structured compensation parsed from the detail's `compensation` block. */
  structuredCompensation: CompensationDto | null;
}
