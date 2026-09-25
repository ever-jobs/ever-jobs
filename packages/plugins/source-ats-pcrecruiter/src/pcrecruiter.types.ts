/**
 * TypeScript interfaces for the PCRecruiter public job board surface.
 *
 * The board is server-rendered ASP.NET HTML — there is no public JSON API.
 * The shapes below model (a) what we scrape from the listing-page job rows and
 * (b) the schema.org `JobPosting` JSON-LD block embedded in each detail page.
 *
 * Every field is optional/nullable so sparse or layout-varying tenants degrade
 * gracefully rather than throwing.
 */

/** A single job summary parsed from a `<table id="joblist">` row on the listing page. */
export interface PCRecruiterListingItem {
  /** PCRecruiter record id from the detail link `recordid` query param. */
  recordId?: string | null;
  /** Job title (anchor text). */
  title?: string | null;
  /** Absolute detail-page URL (carries `recordid` + fresh `pcr-id`). */
  detailUrl?: string | null;
  /** Free-text location label, e.g. "Spring, TX 77389". */
  location?: string | null;
  /** Date-posted label as rendered, e.g. "5/29/2026". */
  datePosted?: string | null;
}

/** schema.org PostalAddress as embedded in the JSON-LD `jobLocation.address`. */
export interface PCRecruiterJsonLdAddress {
  streetAddress?: string | null;
  addressLocality?: string | null;
  addressRegion?: string | null;
  postalCode?: string | null;
  addressCountry?: string | null;
  '@type'?: string | null;
}

/** schema.org Place as embedded in the JSON-LD `jobLocation`. */
export interface PCRecruiterJsonLdPlace {
  address?: PCRecruiterJsonLdAddress | null;
  '@type'?: string | null;
}

/** schema.org Organization as embedded in the JSON-LD `hiringOrganization`. */
export interface PCRecruiterJsonLdOrganization {
  '@type'?: string | null;
  name?: string | null;
  logo?: string | null;
}

/**
 * schema.org `JobPosting` JSON-LD block embedded in a detail page.
 * `jobLocation` may be a single Place or an array of Places.
 */
export interface PCRecruiterJsonLdJobPosting {
  '@context'?: string | null;
  '@type'?: string | null;
  title?: string | null;
  /** Full HTML description string. */
  description?: string | null;
  /** ISO date "YYYY-MM-DD". */
  datePosted?: string | null;
  validThrough?: string | null;
  identifier?: unknown;
  /** e.g. "FULL_TIME", "PART_TIME", "CONTRACTOR". */
  employmentType?: string | null;
  hiringOrganization?: PCRecruiterJsonLdOrganization | null;
  jobLocation?: PCRecruiterJsonLdPlace | PCRecruiterJsonLdPlace[] | null;
  baseSalary?: unknown;
  directApply?: boolean | null;
}

/** Parsed detail-page fields (from JSON-LD, with an HTML-description fallback). */
export interface PCRecruiterJobDetail {
  title?: string | null;
  /** HTML description (from JSON-LD `description` or the `#jobdesc` fallback). */
  descriptionHtml?: string | null;
  datePosted?: string | null;
  employmentType?: string | null;
  companyName?: string | null;
  /** Structured location parsed from JSON-LD `jobLocation.address`. */
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  /** One entry per JSON-LD `jobLocation` Place, when present. */
  locationEntries?: Array<{
    city: string | null;
    state: string | null;
    postalCode: string | null;
    streetAddress: string | null;
    country: string | null;
  }> | null;
  /** Apply URL (the detail page with `?apply=y`, or the registration link). */
  applyUrl?: string | null;
}

/** A listing item merged with its (optional) detail-page enrichment. */
export type PCRecruiterJob = PCRecruiterListingItem & Partial<PCRecruiterJobDetail>;

/** Pagination state extracted from the listing page's pagination form. */
export interface PCRecruiterPagingState {
  /** Fresh server-issued `pcr-id` token for subsequent requests. */
  pcrId?: string | null;
  /** Opaque `unifiedsearch` cursor token used by the pagination POST. */
  unifiedSearch?: string | null;
  /** Total job count reported by `<h1 id="resultcount">1-24 of N</h1>`. */
  total?: number | null;
}
