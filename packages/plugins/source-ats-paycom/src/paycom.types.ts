/**
 * TypeScript interfaces for the Paycom public careers surface.
 *
 * Paycom serves a multi-tenant, clientkey-addressed careers board from
 * `paycomonline.net`. The board is a client-rendered React app that boots a
 * page-embedded bearer token (`configsFromHost.sessionJWT`) and calls an
 * applicant-tracking JSON API: `POST /api/ats/job-posting-previews/search`
 * enumerates a tenant's open roles (`jobPostingPreviews[]`),
 * `GET /api/ats/job-postings/{id}` returns a single role wrapped in `jobPosting`
 * (full HTML body + a `googleJobJson` schema.org string), and
 * `GET /api/ats/company-name` returns the tenant display name.
 *
 * Field names mirror the API wire meaning. Only the fields the adapter consumes
 * are typed; everything is optional and defensively narrowed at parse time.
 */

import { CompensationDto } from '@ever-jobs/models';

/**
 * A single job-posting preview from the search API
 * (`/api/ats/job-posting-previews/search` → `jobPostingPreviews[]`).
 */
export interface PaycomJobPreview {
  /** Stable per-role id (used as the ATS id). */
  jobId?: string | number | null;

  /** Job display title. */
  jobTitle?: string | null;

  /** Single "City, ST ZIP" location string. */
  locations?: string | null;

  /** Truncated listing blurb (the full body comes from the detail call). */
  description?: string | null;

  /** Employment-type label (e.g. "Full Time"), when present. */
  positionType?: string | null;

  /** Remote-mode single-letter code (`R`/`F`/`H`/`T`/`O`/empty). */
  remoteType?: string | null;

  /** Posted date — usually empty on the preview (date lives in the detail). */
  postedOn?: string | null;
}

/** The search API envelope: a page of previews plus a total count. */
export interface PaycomSearchResponse {
  jobPostingPreviews?: PaycomJobPreview[] | null;
  jobPostingPreviewsCount?: number | null;
}

/**
 * A single job-posting detail (`/api/ats/job-postings/{id}` → `jobPosting`).
 * Carries the full visible body as two HTML sections (`description` +
 * `qualifications`) and the Google-for-Jobs schema.org JSON-LD string.
 */
export interface PaycomJobPosting {
  jobId?: string | number | null;
  jobTitle?: string | null;

  /** Single location string (e.g. "Seymour, IN 47274"). */
  location?: string | null;

  /** Employment-type label (e.g. "Full Time"). */
  positionType?: string | null;

  /** Department / category label. */
  jobCategory?: string | null;

  /** Remote-mode single-letter code. */
  remoteType?: string | null;

  /** Free-text pay string (often empty). */
  salaryRange?: string | null;

  /** First visible body section (HTML). */
  description?: string | null;

  /** Second visible body section (HTML) — appended to `description`. */
  qualifications?: string | null;

  /**
   * Google-for-Jobs schema.org `JobPosting` carried as a JSON *string* (or, on
   * some tenants, a pre-parsed object). Holds `datePosted` (absent elsewhere),
   * the canonical job `url`, and any structured `baseSalary`.
   */
  googleJobJson?: string | Record<string, unknown> | null;
}

/** The detail API envelope: the posting is wrapped in `jobPosting`. */
export interface PaycomDetailResponse {
  jobPosting?: PaycomJobPosting | null;
}

/** The company-name API envelope. */
export interface PaycomCompanyNameResponse {
  companyName?: string | null;
}

/**
 * Normalised view of a single Paycom role, assembled from its search preview,
 * detail payload, and the detail's `googleJobJson` schema.org node.
 */
export interface PaycomJob {
  /** Job id — used as the ATS id. */
  jobId: string;

  /** Absolute public detail / apply URL. */
  url: string;

  /** Job display title. */
  title: string | null;

  /** Tenant company display name (from `/api/ats/company-name`). */
  companyName: string | null;

  /** Full job-ad body as HTML (description + qualifications). */
  descriptionHtml: string | null;

  /** Single location string. */
  location: string | null;

  /** Employment-type label. */
  employmentType: string | null;

  /** Department / category label. */
  department: string | null;

  /** Posted date — parsed to YYYY-MM-DD. */
  datePosted: string | null;

  /** True when the role advertises remote / work-from-home. */
  isRemote: boolean;

  /** Raw `remoteType` single-letter code, for the work-from-home label. */
  remoteTypeCode: string | null;

  /** Structured pay parsed from the schema.org `baseSalary`, when present. */
  structuredCompensation: CompensationDto | null;
}
