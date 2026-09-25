/**
 * TypeScript interfaces for the ExactHire (HireCentric) public job-board surface.
 *
 * ExactHire does not expose a single JSON list feed; the `/jobsearch/` listing
 * page links to per-role detail pages. The adapter therefore enumerates a
 * tenant's open roles from its XML sitemap (`/sitemap.xml`) and parses each
 * server-rendered detail page (`/jobs/{jobId}.html`). The interfaces below model
 * the normalised, parsed shape the adapter extracts from those documents. Field
 * names mirror the wire meaning; a handful of `camelCase` aliases are modelled
 * defensively so minor cross-tenant or future-version markup drift never breaks
 * the parser.
 */

/** A single sitemap entry pointing at an open role's detail page. */
export interface ExactHireSitemapEntry {
  /** Role id parsed from `…/jobs/{jobId}.html` (plain or compound). Used as the ATS id. */
  jobId: string;
  /** Absolute detail-page URL (`https://{tenant}.hirecentric.com/jobs/{jobId}.html`). */
  url: string;
  /** ISO-ish `<lastmod>` value from the sitemap, when present. */
  lastmod?: string | null;
}

/**
 * Address sub-object of a schema.org `jobLocation` (PostalAddress), as emitted
 * in the optional JSON-LD JobPosting block on schema.org-enabled tenants.
 */
export interface ExactHirePostalAddress {
  /** e.g. "Washington". */
  addressLocality?: string | null;
  /** e.g. "DC". */
  addressRegion?: string | null;
  /** e.g. "US". */
  addressCountry?: string | { name?: string | null } | null;
}

/**
 * Minimal view of a schema.org JobPosting JSON-LD block. Only the fields the
 * adapter consumes are modelled; everything is optional because not every tenant
 * emits structured data (the parser falls back to the `<title>` / `og:` meta).
 */
export interface ExactHireJsonLd {
  /** Should be "JobPosting" when this block is the role's structured data. */
  '@type'?: string | string[] | null;
  /** Role title. */
  title?: string | null;
  /** ISO publish date. */
  datePosted?: string | null;
  /** ISO expiry date. */
  validThrough?: string | null;
  /** Raw HTML / text job-ad body. */
  description?: string | null;
  /** schema.org employment-type token(s), e.g. "FULL_TIME". */
  employmentType?: string | string[] | null;
  /** Hiring organisation; `name` is the company display name. */
  hiringOrganization?: { name?: string | null } | string | null;
  /** Job location; `address` is a PostalAddress (or array of them). */
  jobLocation?:
    | {
        address?: ExactHirePostalAddress | null;
      }
    | Array<{ address?: ExactHirePostalAddress | null }>
    | null;
}

/**
 * Normalised view of a single ExactHire role, assembled from its sitemap entry
 * and its parsed detail page (JSON-LD when present, else `<title>` / `og:` meta).
 */
export interface ExactHireJob {
  /** Role id — used as the ATS id. */
  jobId: string;

  /** Absolute public detail-page / apply URL. */
  url: string;
  /** Canonical URL from `og:url`, when present. */
  canonicalUrl?: string | null;

  /** Job display title (from JSON-LD / `og:title` / `<title>`). */
  title?: string | null;

  /** Tenant company display name (from JSON-LD `hiringOrganization` / `<title>` tail). */
  company?: string | null;
  companyName?: string | null;

  /** Full job-ad body text (from JSON-LD `description` / `og:description`). */
  description?: string | null;
  /** Full job-ad body as HTML, when a richer markup body is available. */
  descriptionHtml?: string | null;

  /** Structured location parts parsed from JSON-LD / `<title>` / `keywords`. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** One `{city,state,country}` triple per JSON-LD `jobLocation` entry, when present. */
  locationEntries?: Array<{ city: string | null; state: string | null; country: string | null }> | null;

  /** Department / org-unit label, when discernible from the meta. */
  department?: string | null;

  /** Employment-type label (from JSON-LD `employmentType`). */
  employmentType?: string | null;

  /** Posted date — ISO from JSON-LD `datePosted`, else `<lastmod>`. */
  datePosted?: string | null;
}
