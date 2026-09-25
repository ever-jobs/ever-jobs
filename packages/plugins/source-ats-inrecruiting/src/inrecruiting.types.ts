/**
 * TypeScript interfaces for the In-recruiting (Intervieweb) public careers surface.
 *
 * In-recruiting's candidate-facing career board (`/{lang}/career`, or
 * `/{tenant}/{lang}/career` on a shared host) is server-rendered HTML, so there is no
 * stable JSON wire shape to model for the index. The detail page often embeds a
 * schema.org `JobPosting` JSON-LD block; the `InRecruitingJsonLd` interface models the
 * subset of that block the adapter reads. The interfaces below describe (a) the role
 * fragment parsed out of the index card, (b) the JSON-LD detail block, and (c) the
 * normalised internal role assembled from them. Everything the adapter reads is optional
 * and defensively narrowed at parse time, so cross-tenant or future-layout drift never
 * breaks the parser.
 */

/**
 * A single role as parsed out of the index/listing HTML. Assembled from a canonical job
 * anchor (`/jobs/{slug}-{id}/{lang}/`) plus the labelled card text immediately
 * surrounding it ("Location …", "Functional Area …").
 */
export interface InRecruitingListItem {
  /** Numeric In-recruiting job id — the trailing `{id}` of the job token. The ATS id. */
  id: string;
  /** The `{slug}-{id}` token from the job URL (e.g. `communication-manager-410`). */
  token?: string | null;
  /** Absolute canonical job detail / apply URL parsed from the anchor's href. */
  url?: string | null;
  /** Human-readable job title (from the card heading text). */
  title?: string | null;
  /** Raw location text (from the "Location …" card field). */
  location?: string | null;
  /** Raw functional-area / department text (from the "Functional Area …" card field). */
  functionalArea?: string | null;
}

/**
 * The subset of a schema.org `JobPosting` JSON-LD block the adapter reads from a detail
 * page. Present on the classic career-site detail variant; absent on some "SMART" path-
 * tenant variants (handled by the og:/title/card fallbacks). All fields optional.
 */
export interface InRecruitingJsonLd {
  /** Schema type — only blocks whose `@type` is `JobPosting` are used. */
  '@type'?: string | string[];
  /** Role title. */
  title?: string | null;
  /** Role description as an HTML fragment. */
  description?: string | null;
  /** ISO date the role was posted (e.g. `2026-05-14`). */
  datePosted?: string | null;
  /** ISO date the role closes (e.g. `2026-06-13`). */
  validThrough?: string | null;
  /** schema.org employment-type token (e.g. `FULL_TIME`), when present. */
  employmentType?: string | string[] | null;
  /** Hiring organisation — the tenant brand name lives in `.name`. */
  hiringOrganization?: { name?: string | null; sameAs?: string | null } | null;
  /** Place describing the role's location; the useful parts are in `.address`. */
  jobLocation?: InRecruitingJsonLdPlace | InRecruitingJsonLdPlace[] | null;
  /** schema.org location type (`TELECOMMUTE` indicates remote), when present. */
  jobLocationType?: string | null;
  /** Industry / department label, when present. */
  industry?: string | null;
}

/** A per-site location entry derived from one JSON-LD `jobLocation` Place. */
export interface LocationEntry {
  city: string | null;
  state: string | null;
  country: string | null;
  streetAddress?: string | null;
  postalCode?: string | null;
}

/** A schema.org `Place` with a `PostalAddress`, as embedded under `jobLocation`. */
export interface InRecruitingJsonLdPlace {
  '@type'?: string;
  address?: {
    '@type'?: string;
    streetAddress?: string | null;
    addressLocality?: string | null;
    addressRegion?: string | null;
    postalCode?: string | null;
    addressCountry?: string | null;
  } | null;
}

/**
 * Normalised view of a single In-recruiting role, ready to map to a JobPostDto.
 */
export interface InRecruitingJob {
  /** Numeric In-recruiting job id — used as the ATS id. */
  jobId: string;

  /** Absolute public detail / apply URL (the canonical career job page). */
  url: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant company display name (JSON-LD hiringOrganization, else de-slugified tenant). */
  companyName?: string | null;

  /** Structured location parts derived from JSON-LD address or the card location text. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** One entry per JSON-LD `jobLocation` Place, when present. */
  locationEntries?: LocationEntry[] | null;

  /** Raw single-line location string (used for the remote signal). */
  locationText?: string | null;

  /** Role description (HTML), from JSON-LD `description` or `og:description`. */
  description?: string | null;

  /** Functional-area / department label. */
  department?: string | null;

  /** Employment-type label (normalised from JSON-LD `employmentType`), when present. */
  employmentType?: string | null;

  /** Posted date — parsed from JSON-LD `datePosted`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / smart-working. */
  isRemote?: boolean | null;
}
