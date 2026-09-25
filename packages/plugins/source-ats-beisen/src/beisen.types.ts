/**
 * TypeScript interfaces for the Beisen (北森 / iTalent) public careers surface.
 *
 * A Beisen tenant career site (`https://{slug}.zhiye.com`) is a client-rendered SPA that boots
 * from an inline `BSGlobal` config block (GET `/portal/registerSystemInfo`) and serves open
 * roles from a public, anonymous JSON listing endpoint (POST `/api/Jobad/GetJobAdPageList`).
 * The interfaces below describe the subset of the wire shape the adapter reads plus the
 * normalised internal role assembled from it. Everything the adapter reads is optional and
 * defensively narrowed at parse time, so cross-tenant or future-shape drift never breaks the
 * parser.
 */

/** The inline portal-config object literal (`var BSGlobal = { … }`) on the career-site HTML. */
export interface BeisenBsGlobal {
  /** Opaque tenant key (kept for provenance only). */
  Key?: string | null;
  /** Tenant branded company display name. */
  Name?: string | null;
  /** Tenant portal id — required; sent in every listing request body. */
  PortalId?: string | null;
  /** Career-site template code (e.g. `template10`). */
  Code?: string | null;
}

/**
 * A single open role as returned by the listing endpoint. Only the fields the adapter consumes
 * are modelled; all are optional and defensively narrowed. Field-name variants seen across
 * Beisen responses are all read so minor shape drift never drops a role.
 */
export interface BeisenJobRecord {
  /** Numeric role id — the stable ATS id and the `/portal/jobs/{id}` URL segment. */
  JobAdId?: number | string | null;
  /** Role title. */
  JobAdName?: string | null;
  /** Alternate role title key. */
  Name?: string | null;
  /** Array of city / region name strings for the role. */
  LocNames?: Array<string | null> | null;
  /** Alternate flat location string. */
  Location?: string | null;
  /** Role responsibilities body (part of the description). */
  Duty?: string | null;
  /** Role requirements body (part of the description). */
  Require?: string | null;
  /** Alternate single-field description body. */
  Description?: string | null;
  /** Free-text salary summary, when present. */
  Salary?: string | null;
  /** Recruitment category label — used as the department. */
  Category?: string | null;
  /** Alternate department key. */
  Department?: string | null;
  /** ISO change timestamp (most-recent edit). */
  ChangeDate?: string | null;
  /** ISO original post timestamp. */
  PostDate?: string | null;
  /** Role status flag (1 = open). */
  Status?: number | string | null;
  /** Organisation id, when present. */
  OrgId?: number | string | null;
}

/**
 * The standard Beisen listing envelope. `Data` is the open-role array; `Count` is the total
 * open-role count (used to bound pagination). `Code` is `200` on success.
 */
export interface BeisenListEnvelope {
  /** Result code (`200` on success). */
  Code?: number | string | null;
  /** Result message. */
  Message?: string | null;
  /** Total open-role count, when present. */
  Count?: number | string | null;
  /** The open-role array. */
  Data?: BeisenJobRecord[] | null;
}

/** Normalised view of a single Beisen role, ready to map to a JobPostDto. */
export interface BeisenJob {
  /** Stable ATS id (the numeric role `JobAdId`). */
  atsId: string;
  /** Absolute public detail URL (the canonical career-site job page). */
  url: string;
  /** Absolute public apply URL. */
  applyUrl: string;
  /** Job display title. */
  title?: string | null;
  /** Tenant company display name (BSGlobal `Name`, else de-slugified tenant token). */
  companyName?: string | null;
  /** Structured location parts derived from the role's `LocNames`. */
  city?: string | null;
  state?: string | null;
  country?: string | null;
  /** Raw single-line location string, used for remote detection. */
  locationText?: string | null;
  /** Per-site location triples (one entry per `LocNames` element). */
  locationEntries?: { city: string | null; state: string | null; country: string | null }[] | null;
  /** Role-ad body (joined `Duty` + `Require`, or `Description`), when present. */
  descriptionHtml?: string | null;
  /** Department / recruitment-category label. */
  department?: string | null;
  /** Free-text salary summary, when present. */
  salaryText?: string | null;
  /** Posted date — parsed from `ChangeDate` / `PostDate`, when available. */
  datePosted?: string | null;
  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;
}

/** A resolved Beisen tenant: slug + origin + the portal id needed to list roles. */
export interface ResolvedBeisenTenant {
  /** Company slug (the `{slug}` subdomain token, e.g. `mengniu`). */
  slug: string;
  /** Tenant career-site origin (`https://{slug}.zhiye.com`). */
  base: string;
  /** Tenant portal id from `BSGlobal.PortalId` — required for the listing call. */
  portalId: string;
  /** Tenant branded company display name from `BSGlobal.Name`, when present. */
  companyName?: string | null;
  /** Numeric tenant id from the page's image-CDN URLs, when present (provenance only). */
  tenantId?: string | null;
}
