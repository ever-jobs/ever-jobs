/**
 * TypeScript interfaces for the BeeSite public careers surface.
 *
 * BeeSite tenant portals expose their open roles through a JobBoardApi JSON endpoint
 * that returns the HR-XML "MatchedObjectDescriptor" envelope, and — as a fallback — a
 * server-rendered `?ac=search_result` list of `SearchResultBox` rows linking to
 * `?ac=jobad&id={PositionID}` detail pages. The interfaces below describe the subset
 * of the JSON wire shape the adapter reads plus the normalised internal role assembled
 * from either surface. Everything the adapter reads is optional and defensively
 * narrowed at parse time, so cross-tenant or future-shape drift never breaks the
 * parser.
 */

/** A localised rich-text block (e.g. the formatted job-ad body) in the JSON envelope. */
export interface BeeSiteFormattedContent {
  /** Optional content-type / label of the block (e.g. `text/html`). */
  Label?: string | null;
  /** The HTML / text content of the block. */
  Content?: string | null;
}

/** A single position location entry in the JSON envelope. */
export interface BeeSitePositionLocation {
  /** City name, when present (e.g. `Frankfurt am Main`). */
  CityName?: string | null;
  /** State / region name, when present. */
  CountrySubDivisionName?: string | null;
  /** Country name, when present (e.g. `Germany`). */
  CountryName?: string | null;
  /** Free-text location label, when present (alternate to the structured parts). */
  LocationName?: string | null;
}

/**
 * The descriptor of a single matched open position in the JobBoardApi JSON envelope.
 * Only the fields the adapter consumes are modelled; all are optional and defensively
 * narrowed.
 */
export interface BeeSiteMatchedObjectDescriptor {
  /** Stable BeeSite position id — the `id` segment of the `?ac=jobad&id=` detail URL. */
  PositionID?: string | number | null;
  /** Job display title. */
  PositionTitle?: string | null;
  /** Canonical public detail URL for the role, when the API emits an absolute link. */
  PositionURI?: string | null;
  /** Structured location entries for the role. */
  PositionLocation?: BeeSitePositionLocation[] | null;
  /** Employing organisation / brand name, when present. */
  OrganizationName?: string | null;
  /** Department / organisational-unit label, when present. */
  DepartmentName?: string | null;
  /** Employment-type / schedule label (e.g. `Full-time`), when present. */
  PositionOfferingType?: { Name?: string | null }[] | string | null;
  /** Work-schedule label (alternate employment-type source), when present. */
  PositionSchedule?: { Name?: string | null }[] | string | null;
  /** ISO publish timestamp, when present. */
  PublicationStartDate?: string | null;
  /** Rich formatted job-ad body (HTML), when present. */
  PositionFormattedDescription?: BeeSiteFormattedContent | BeeSiteFormattedContent[] | null;
}

/** A single search-result item wrapping a matched-object descriptor. */
export interface BeeSiteSearchResultItem {
  /** Opaque match id (alternate stable id when `PositionID` is absent). */
  MatchedObjectId?: string | number | null;
  /** The position descriptor. */
  MatchedObjectDescriptor?: BeeSiteMatchedObjectDescriptor | null;
}

/** The `SearchResult` envelope returned by the JobBoardApi. */
export interface BeeSiteSearchResult {
  /** Total number of matching roles for the tenant. */
  SearchResultCount?: number | null;
  /** Number of items in this page of results. */
  SearchResultCountAll?: number | null;
  /** The page of matched roles. */
  SearchResultItems?: BeeSiteSearchResultItem[] | null;
}

/** The top-level JobBoardApi JSON response envelope. */
export interface BeeSiteApiResponse {
  /** The search result payload. */
  SearchResult?: BeeSiteSearchResult | null;
}

/**
 * A role parsed from the server-rendered `?ac=search_result` HTML fallback: the
 * `PositionID` (from the `?ac=jobad&id=` link) plus best-effort title / location text
 * read from the surrounding `SearchResultBox` row.
 */
export interface BeeSiteListRow {
  /** Stable BeeSite position id (the `id` from the `?ac=jobad&id=` detail link). */
  positionId: string;
  /** Job display title, when readable from the row. */
  title?: string | null;
  /** Free-text location string, when readable from the row. */
  location?: string | null;
  /** Absolute detail URL, when the row's anchor carried one. */
  url?: string | null;
}

/**
 * Normalised view of a single BeeSite role, ready to map to a JobPostDto.
 */
export interface BeeSiteJob {
  /** Stable ATS id (the BeeSite `PositionID`). */
  atsId: string;

  /** Absolute public detail URL (the canonical `?ac=jobad&id=` job-ad page). */
  url: string;

  /** Absolute public apply URL. */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Employing company display name (from the API, else derived from the slug). */
  companyName?: string | null;

  /** Structured location parts derived from the role's location entries / text. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** Raw single-line location string, used for remote detection. */
  locationText?: string | null;

  /** Per-site location triples (one entry per usable `PositionLocation` record). */
  locationEntries?: { city: string | null; state: string | null; country: string | null }[] | null;

  /** HTML job-ad body (the richest description available), when present. */
  descriptionHtml?: string | null;

  /** Department / organisational-unit label. */
  department?: string | null;

  /** Employment-type label (e.g. `Full-time`), when present. */
  employmentType?: string | null;

  /** Posted date — parsed from `PublicationStartDate`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-office working. */
  isRemote?: boolean | null;
}
