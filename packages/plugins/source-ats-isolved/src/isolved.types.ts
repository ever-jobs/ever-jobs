/**
 * TypeScript interfaces for the isolved Hire public careers surface.
 *
 * The adapter consumes two data sources:
 *   1. The board's JSON API (`/core/jobs/{domainId}`) for structured fields.
 *   2. Each role's detail page JSON-LD `JobPosting` for the description body.
 */

/** A single job record from the `/core/jobs/{domainId}` JSON API response. */
export interface IsolvedApiJob {
  id: number;
  title: string;
  city?: string | null;
  abbreviation?: string | null;
  iso3?: string | null;
  stateName?: string | null;
  classification?: string | null;
  orgTitle?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  minSalary?: string | null;
  maxSalary?: string | null;
  payType?: string | null;
  payTypeFrame?: string | null;
  payDetails?: string | null;
  jobUrl?: string | null;
  subdomain?: string | null;
  domainName?: string | null;
  streetAddress?: string | null;
  jobLocation?: string | null;
  startDateRef?: string | null;
  endDateRef?: string | null;
  siteId?: number | null;
}

/** Metadata extracted from the board HTML shell (componentData). */
export interface IsolvedBoardMeta {
  domainId: string;
  companyName: string | null;
}

/** Description + datePosted extracted from a detail page's JSON-LD. */
export interface IsolvedDetailData {
  descriptionHtml: string | null;
  datePosted: string | null;
}

/**
 * The `address` sub-object of a JSON-LD `JobPosting.jobLocation.address`
 * (schema.org `PostalAddress`). Only the parts the adapter maps are modelled.
 */
export interface IsolvedPostalAddress {
  addressLocality?: string | null;
  addressRegion?: string | null;
  addressCountry?: string | null;
}

/**
 * The `jobLocation` sub-object of a JSON-LD `JobPosting` (schema.org `Place`).
 */
export interface IsolvedJobLocation {
  address?: IsolvedPostalAddress | null;
}

/** The `hiringOrganization` sub-object of a JSON-LD `JobPosting`. */
export interface IsolvedHiringOrganization {
  name?: string | null;
}

/**
 * A single role's JSON-LD `JobPosting`, as embedded in its `/jobs/{jobId}.html`
 * detail page. Only the fields the adapter consumes are modelled.
 */
export interface IsolvedJobPosting {
  '@type'?: string | string[] | null;
  title?: string | null;
  url?: string | null;
  description?: string | null;
  datePosted?: string | null;
  employmentType?: string | string[] | null;
  hiringOrganization?: IsolvedHiringOrganization | null;
  jobLocation?: IsolvedJobLocation | IsolvedJobLocation[] | null;
}
