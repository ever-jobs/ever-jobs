/**
 * TypeScript interfaces for the Eddy public careers surface.
 *
 * Eddy tenant careers boards (`https://app.eddy.com/careers/{organizationUuid}`) are
 * single-page applications that fetch the open-roles set from a public, anonymous JSON
 * API keyed by the organization UUID:
 *
 *   GET /api/ats/public/job-opening/organization/{organizationUuid}
 *       → array of lightweight list records (`EddyJobListItem`).
 *   GET /api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}
 *       → per-role detail (`EddyJobDetail`) enriching a list record.
 *
 * The interfaces below describe the subset of that wire shape the adapter reads plus the
 * normalised internal role assembled from it. Everything the adapter reads is optional and
 * defensively narrowed at parse time, so cross-tenant or future-shape drift never breaks
 * the parser.
 */

/**
 * A single role as returned by the public list endpoint
 * (`/api/ats/public/job-opening/organization/{organizationUuid}`). The list record is
 * lightweight — it carries IDs (not resolved names) for department / location; the
 * description, employment type, and workplace type live on the per-role detail record.
 * Only the fields the adapter consumes are modelled; all are optional and defensively
 * narrowed.
 */
export interface EddyJobListItem {
  /** Role UUID — the stable ATS id and the final segment of `/careers/{org}/{jobUuid}`. */
  jobOpeningUuid?: string | null;
  /** Role display title. */
  title?: string | null;
  /** Department identifier (resolved to a name only via an authenticated HR endpoint). */
  departmentId?: number | string | null;
  /** Location identifier (resolved to a name only via an authenticated HR endpoint). */
  locationId?: number | string | null;
  /** ISO publish timestamp. */
  postedDate?: string | null;
}

/**
 * A role as returned by the public per-role detail endpoint
 * (`/api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}`). It
 * enriches the list record with the body and the structured employment / workplace flags.
 * Only the fields the adapter consumes are modelled; all are optional + defensively
 * narrowed.
 */
export interface EddyJobDetail {
  /** Role display title (echoed from the list record). */
  title?: string | null;
  /** Employment type token (e.g. `FULL_TIME`, `PART_TIME`, `CONTRACT`). */
  employmentType?: string | null;
  /** Free-text experience requirement (e.g. `2 years plus`). */
  experience?: string | null;
  /** Role description body — HTML when present. */
  description?: string | null;
  /** ISO publish timestamp (echoed from the list record). */
  postedDate?: string | null;
  /** Free-text / structured compensation, when published. */
  compensation?: string | null;
  /** Department identifier. */
  departmentId?: number | string | null;
  /** Location identifier. */
  locationId?: number | string | null;
  /** Workplace arrangement token (`ON_SITE` / `HYBRID` / `REMOTE`). */
  workplaceType?: string | null;
  /** True when the role is published to the public careers board. */
  publishToCareers?: boolean | null;
}

/**
 * The public slug→UUID lookup response (`/api/ds/organization/{slug}/id`) — the same
 * call the careers SPA issues for vanity careers URLs. `organizationUuid` then keys the
 * jobs endpoints.
 */
export interface EddyOrganizationIdResponse {
  /** The tenant's vanity short name, echoed back. */
  currentShortName?: string | null;
  /** The tenant's organization UUID — required by every jobs endpoint. */
  organizationUuid?: string | null;
}

/**
 * Normalised view of a single Eddy role, ready to map to a JobPostDto.
 */
export interface EddyJob {
  /** Stable ATS id (the role `jobOpeningUuid`). */
  atsId: string;

  /** Absolute public detail URL (the canonical careers `/careers/{org}/{jobUuid}` page). */
  url: string;

  /** Absolute public apply URL (the same detail page hosts the apply flow). */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant company display name (the de-slugified org token — see note below). */
  companyName?: string | null;

  /** Role description body (HTML, from the per-role detail) when fetched, else null. */
  descriptionHtml?: string | null;

  /** Employment type token (from the per-role detail), when fetched. */
  employmentType?: string | null;

  /** Posted date — parsed from `postedDate`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;
}
