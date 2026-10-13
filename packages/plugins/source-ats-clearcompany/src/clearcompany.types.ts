/**
 * TypeScript interfaces for the ClearCompany public careers jobs API.
 *
 * The feed (`GET /api/v1/careers/jobs`, tenant via the `API-ShortName` header)
 * returns a flat array of job objects. Field names mirror the real wire shape,
 * which is PascalCase. Optional `snake_case`/`camelCase` aliases are modelled
 * defensively so minor cross-tenant drift never breaks the parser.
 */

/** A single open position as returned by `/api/v1/careers/jobs`. */
export interface ClearCompanyJob {
  /** Stable job GUID — used as the ATS id and the job-detail URL segment. */
  Id?: string | null;
  id?: string | null;

  /** Tenant / organization display name (e.g. "ClearCompany-1132"). */
  OrganizationName?: string | null;
  OrganizationId?: number | string | null;

  /** Structured department / office identifiers + display names. */
  DepartmentId?: string | null;
  DepartmentName?: string | null;
  OfficeId?: string | null;
  /** Free-text office/location label (e.g. "Copley Square, Boston"). */
  OfficeName?: string | null;

  /** Recruiter metadata (unused in mapping, modelled for completeness). */
  RecruiterUserId?: string | null;
  RecruiterName?: string | null;

  /** Primary title field; lower-case aliases are defensive fallbacks. */
  PositionTitle?: string | null;
  positionTitle?: string | null;
  Title?: string | null;
  title?: string | null;

  /** HTML job description. */
  Description?: string | null;
  description?: string | null;

  /** ISO-8601 open/posted date (e.g. "2013-08-10T04:00:00Z"). */
  OpenDate?: string | number | null;
  openDate?: string | number | null;

  /** Per-job apply URL (e.g. "https://{slug}.clearcompany.com/careers/jobs/{id}/apply"). */
  ApplyUrl?: string | null;
  applyUrl?: string | null;
  /** Optional referral URL. */
  ReferUrl?: string | null;

  /** Self-scheduling flag (unused in mapping). */
  HasSelfScheduling?: boolean | null;
}

/** The feed responds with a bare array; this alias documents that envelope. */
export type ClearCompanyJobsResponse = ClearCompanyJob[];

/**
 * Structured location entry in the per-site (widget) feed.
 * Richer than the legacy feed's free-text `OfficeName`.
 */
export interface ClearCompanySiteLocation {
  city?: string | null;
  subdivision?: string | null;
  subdivisionFullName?: string | null;
  country?: string | null;
  postalCode?: string | null;
  isRemote?: boolean | null;
  isNationwide?: boolean | null;
}

/**
 * A single position as returned by the per-site feed
 * `GET https://careers-api.clearcompany.com/v1/{siteId}` — the feed the
 * tenant's embedded careers widget renders (camelCase wire shape).
 */
export interface ClearCompanySiteJob {
  /** Stable job GUID — used as the ATS id and inside `applyLink`. */
  id?: string | null;
  /** Human-facing requisition number (e.g. "3002", "26-07-04"). */
  userDefinedId?: string | null;
  positionTitle?: string | null;
  /** HTML job description. */
  description?: string | null;
  /** ISO-8601 dates ("2026-09-11T00:00:00"). */
  openDate?: string | null;
  postedDate?: string | null;
  departmentName?: string | null;
  officeName?: string | null;
  jobFunctionName?: string | null;
  /** Free-text display location (e.g. "Cedar Park TX"). */
  location?: string | null;
  /** Structured locations (one job may carry several). */
  locations?: ClearCompanySiteLocation[] | null;
  /** Tenant display name (e.g. "Firefly Aerospace"). */
  brandName?: string | null;
  /** Absolute apply URL on the tenant host ({slug}.clearcompany.com). */
  applyLink?: string | null;
  salaryRangeLow?: string | null;
  salaryRangeHigh?: string | null;
  salaryType?: string | null;
}

/** Envelope of `GET /v1/{siteId}` — the full site list arrives in one page. */
export interface ClearCompanySiteJobsResponse {
  results?: ClearCompanySiteJob[] | null;
  totalCount?: number | null;
  currentPageIndex?: number | null;
  currentPageCount?: number | null;
}
