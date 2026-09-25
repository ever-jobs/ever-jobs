/**
 * TypeScript interfaces for the MokaHR public careers surface.
 *
 * A MokaHR tenant career site (`app.mokahr.com/social-recruitment/{tenant}/{orgId}`) is
 * a client-rendered SPA whose open roles are served by a public, anonymous JSON listing
 * endpoint (`api.mokahr.com/api-platform/v1/jobs/{orgId}?mode=social`). The endpoint
 * returns the standard MokaHR `{ code, msg, data }` envelope; `data` carries the open
 * roles. The interfaces below describe the subset of the wire shape the adapter reads
 * plus the normalised internal role assembled from it. Everything the adapter reads is
 * optional and defensively narrowed at parse time, so cross-tenant or future-shape drift
 * never breaks the parser.
 */

/** A single role location entry, as embedded in a listing role record. */
export interface MokaHrLocation {
  /** Location id. */
  id?: number | string | null;
  /** City name (e.g. `Shanghai`). */
  city?: string | null;
  /** Province / state name. */
  province?: string | null;
  /** Free-text street address, when present. */
  address?: string | null;
  /** Country name, when present. */
  country?: string | null;
  /** Composed display name, when the wire pre-joins the parts. */
  name?: string | null;
}

/** A department / organisational-unit reference, as embedded in a listing role record. */
export interface MokaHrDepartment {
  /** Department id. */
  id?: number | string | null;
  /** Department display name. */
  name?: string | null;
}

/**
 * A single open role as returned by the public listing endpoint. Only the fields the
 * adapter consumes are modelled; all are optional and defensively narrowed. Field-name
 * variants seen across MokaHR responses (e.g. `jobTitle` vs `title`, `updatedAt` vs
 * `publishedAt`) are all read so minor shape drift never drops a role.
 */
export interface MokaHrJobRecord {
  /** Numeric role id — the stable ATS id and the `#/job/{id}` URL segment. */
  id?: number | string | null;
  /** Alternate role id key. */
  jobId?: number | string | null;
  /** Role title. */
  title?: string | null;
  /** Alternate title key. */
  jobTitle?: string | null;
  /** Alternate (localised) title key. */
  name?: string | null;
  /** Structured locations for the role. */
  locations?: MokaHrLocation[] | null;
  /** Single location object (alternate shape). */
  location?: MokaHrLocation | string | null;
  /** Free-text city, when the wire flattens location. */
  city?: string | null;
  /** Department reference (object or bare name string). */
  department?: MokaHrDepartment | string | null;
  /** Alternate department name key. */
  departmentName?: string | null;
  /** HTML job-ad body (the rich description). */
  description?: string | null;
  /** Alternate description / requirement keys. */
  jobDescription?: string | null;
  requirement?: string | null;
  /** Employment-type label, when present. */
  employmentType?: string | null;
  jobType?: string | null;
  /** ISO publish / update timestamps, when present. */
  publishedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  /** Absolute or relative detail URL, when the wire pre-builds it. */
  url?: string | null;
}

/**
 * The standard MokaHR API envelope. `data` is narrowed defensively: it may be the role
 * array directly, or an object whose `jobs` / `list` / `items` / `content` array holds
 * the roles (and may carry a `total` count for pagination).
 */
export interface MokaHrApiEnvelope {
  /** Result code (`0` / `200` on success in MokaHR responses). */
  code?: number | string | null;
  /** Result message. */
  msg?: string | null;
  /** The payload — roles array, or a wrapper object holding one. */
  data?: MokaHrJobRecord[] | MokaHrJobListData | null;
}

/** A wrapper object form of the listing payload, holding the roles + an optional total. */
export interface MokaHrJobListData {
  /** Open roles (primary key). */
  jobs?: MokaHrJobRecord[] | null;
  /** Open roles (alternate keys). */
  list?: MokaHrJobRecord[] | null;
  items?: MokaHrJobRecord[] | null;
  content?: MokaHrJobRecord[] | null;
  /** Total open-role count, when present (used to bound pagination). */
  total?: number | string | null;
}

/**
 * Normalised view of a single MokaHR role, ready to map to a JobPostDto.
 */
export interface MokaHrJob {
  /** Stable ATS id (the numeric role `id`). */
  atsId: string;

  /** Absolute public detail URL (the canonical career-site job page). */
  url: string;

  /** Absolute public apply URL. */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant company display name (derived from the slug — the listing carries no brand name). */
  companyName?: string | null;

  /** Structured location parts derived from the role's location data. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** Raw single-line location string, used for remote detection. */
  locationText?: string | null;

  /** Per-site location triples (one entry per usable `locations[]` record). */
  locationEntries?: { city: string | null; state: string | null; country: string | null }[] | null;

  /** HTML job-ad body (the richest description available), when present. */
  descriptionHtml?: string | null;

  /** Department / organisational-unit label. */
  department?: string | null;

  /** Employment-type label, when present. */
  employmentType?: string | null;

  /** Posted date — parsed from `publishedAt` / `updatedAt`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;
}
