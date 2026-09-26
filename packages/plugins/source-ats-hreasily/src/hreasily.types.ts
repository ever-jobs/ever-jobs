/**
 * TypeScript interfaces for the HReasily public careers surface.
 *
 * A HReasily tenant career page (`careers.hreasily.com/{slug}`) is server-rendered and
 * embeds its open roles as schema.org `JobPosting` JSON-LD islands (one `JobPosting` per
 * role, or a single `ItemList` whose `itemListElement[]` wrap them), optionally alongside a
 * server-side-rendered data island (an embedded JSON array of the same roles). The adapter
 * GETs the page, extracts the JSON-LD (falling back to the data island, then to a light HTML
 * anchor scrape), and reads each role. The interfaces below describe the subset of that wire
 * shape the adapter reads plus the normalised internal role assembled from it. Everything the
 * adapter reads is optional and defensively narrowed at parse time, so cross-tenant or
 * future-shape drift never breaks the parser.
 */

/** A schema.org `PostalAddress` block on a `JobPosting.jobLocation.address`. */
export interface HReasilyPostalAddress {
  /** `@type` discriminator (`PostalAddress`). */
  '@type'?: string | null;
  /** Free-text locality / city (e.g. `Singapore`). */
  addressLocality?: string | null;
  /** Free-text region / state / province. */
  addressRegion?: string | null;
  /** Country — a free-text name or a `{ name }` `Country` object. */
  addressCountry?: string | { name?: string | null } | null;
  /** Postal code (ignored — defensive). */
  postalCode?: string | null;
  /** Street address (ignored — defensive). */
  streetAddress?: string | null;
}

/** A schema.org `Place` block on a `JobPosting.jobLocation`. */
export interface HReasilyJobLocation {
  /** `@type` discriminator (`Place`). */
  '@type'?: string | null;
  /** The place's postal address. */
  address?: HReasilyPostalAddress | string | null;
}

/** A schema.org `Organization` block on a `JobPosting.hiringOrganization`. */
export interface HReasilyHiringOrganization {
  /** `@type` discriminator (`Organization`). */
  '@type'?: string | null;
  /** Employer display name (e.g. the tenant's company name). */
  name?: string | null;
  /** Employer site URL (ignored — defensive). */
  sameAs?: string | null;
  /** Employer logo URL (ignored — defensive). */
  logo?: string | null;
}

/**
 * A single open role as a schema.org `JobPosting`. Only the fields the adapter consumes are
 * modelled; all are optional and defensively narrowed.
 */
export interface HReasilyJobPosting {
  /** JSON-LD `@type` (`JobPosting`). */
  '@type'?: string | null;
  /** Stable role identifier — schema.org `identifier` (string, number, or `{ value }`). */
  identifier?: string | number | { value?: string | number | null } | null;
  /** Role display title. */
  title?: string | null;
  /** Rendered HTML (or plain) description body. */
  description?: string | null;
  /** Canonical public detail / apply URL for the role. */
  url?: string | null;
  /** Apply URL when distinct from the detail URL (ignored unless present). */
  applicationContact?: unknown;
  /** ISO-ish publish date (`YYYY-MM-DD` or full ISO). */
  datePosted?: string | null;
  /** ISO-ish closing date (ignored — defensive). */
  validThrough?: string | null;
  /** Employment-type token(s) (e.g. `FULL_TIME`, or an array of them). */
  employmentType?: string | string[] | null;
  /** Department / category / occupational-category label. */
  occupationalCategory?: string | null;
  /** Free-text industry (used as a department fallback). */
  industry?: string | null;
  /** The hiring employer. */
  hiringOrganization?: HReasilyHiringOrganization | string | null;
  /** Structured location (a single `Place` or an array of them). */
  jobLocation?: HReasilyJobLocation | HReasilyJobLocation[] | null;
  /** Whether the role is fully remote (`TELECOMMUTE` per schema.org). */
  jobLocationType?: string | null;
}

/**
 * One `itemListElement[]` wrapper in a JSON-LD `ItemList` of roles. schema.org allows either
 * a bare item or a `ListItem` whose `item` holds the `JobPosting`.
 */
export interface HReasilyListItem {
  /** `@type` discriminator (`ListItem`). */
  '@type'?: string | null;
  /** Ordinal position in the list (ignored — defensive). */
  position?: number | null;
  /** The wrapped role, when nested under `item`. */
  item?: HReasilyJobPosting | null;
  /** A direct role reference, when not nested (defensive). */
  '@id'?: string | null;
}

/**
 * A JSON-LD island as parsed from a `<script type="application/ld+json">` block. It may be a
 * single `JobPosting`, an `ItemList` of them, or an array of mixed nodes (a `@graph`). Only
 * the paths the adapter walks are modelled.
 */
export interface HReasilyJsonLd {
  /** JSON-LD `@type` (`JobPosting`, `ItemList`, …). */
  '@type'?: string | null;
  /** `ItemList.itemListElement[]` — the wrapped roles. */
  itemListElement?: HReasilyListItem[] | HReasilyJobPosting[] | null;
  /** A `@graph` array of mixed JSON-LD nodes (some of which may be `JobPosting`s). */
  '@graph'?: Array<HReasilyJobPosting | HReasilyJsonLd> | null;
}

/**
 * A single role as it may appear in a server-side-rendered data island (an embedded JSON
 * array of the tenant's open roles, when the page exposes one). Field names mirror the
 * platform's own internal shape; all optional / defensively narrowed.
 */
export interface HReasilyDataIslandJob {
  /** Stable role id. */
  id?: string | number | null;
  /** Alternate stable role id key. */
  jobId?: string | number | null;
  /** Role title. */
  title?: string | null;
  /** Alternate title key. */
  name?: string | null;
  /** HTML / plain description body. */
  description?: string | null;
  /** Canonical detail / apply URL or slug. */
  url?: string | null;
  /** Alternate apply URL key. */
  applyUrl?: string | null;
  /** City / locality. */
  city?: string | null;
  /** Alternate location free-text. */
  location?: string | null;
  /** State / region. */
  state?: string | null;
  /** Country. */
  country?: string | null;
  /** Department / category. */
  department?: string | null;
  /** Employment-type label. */
  employmentType?: string | null;
  /** Alternate employment-type key. */
  jobType?: string | null;
  /** Posted date. */
  datePosted?: string | null;
  /** Alternate posted-date key. */
  createdAt?: string | null;
  /** Remote flag, when present. */
  remote?: boolean | null;
}

/**
 * Normalised view of a single HReasily role, ready to map to a JobPostDto.
 */
export interface HReasilyJob {
  /** Stable ATS id (the role identifier / id). */
  atsId: string;

  /** Absolute public detail URL for the role. */
  url: string;

  /** Absolute public apply URL (the detail page hosts the apply flow). */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant / employer company display name. */
  companyName?: string | null;

  /** Structured location parts derived from the role. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** One `{city,state,country}` triple per JSON-LD `jobLocation` entry, when present. */
  locationEntries?: Array<{ city: string | null; state: string | null; country: string | null }> | null;

  /** Combined free-text location, used for remote detection. */
  locationText?: string | null;

  /** Role description body (HTML when present), else null. */
  descriptionHtml?: string | null;

  /** Department label, derived from the role's category / industry. */
  department?: string | null;

  /** Employment-type display label (e.g. `Full Time`). */
  employmentType?: string | null;

  /** Posted date — parsed from `datePosted`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;
}
