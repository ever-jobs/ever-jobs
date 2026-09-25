/**
 * TypeScript interfaces for the Bizneo HR public careers surface.
 *
 * Bizneo HR's candidate-facing board (`/jobs` on `{tenant}.bizneo.com`) is a
 * server-rendered open-roles index whose per-role detail body is hydrated
 * client-side. The adapter therefore parses the index HTML — anchoring on each
 * `/jobs/{slug}` job link and reading the labelled card text immediately around it
 * (the title, a location line, an optional brand label, and an "On-site" /
 * "Remote" / "Hybrid" work-mode token). The board is HTML, so there is no JSON
 * wire shape to model for the listing; the interfaces below describe the parsed
 * fragments extracted from each job card and the normalised internal role
 * assembled from them, plus the optional schema.org `JobPosting` JSON-LD shape used
 * as a defensive enrichment when the board emits one. Everything the adapter reads
 * is optional and defensively narrowed at parse time, so cross-tenant or future
 * layout drift never breaks the parser.
 */

/**
 * A single role as parsed out of the board index HTML. Assembled from a job anchor
 * (`/jobs/{slug}`) plus the labelled card text immediately surrounding it.
 */
export interface BizneoBoardJob {
  /** The `{slug}` path segment — the stable per-role token, used as the ATS id. */
  slug: string;
  /** Absolute canonical detail / apply URL parsed/built from the anchor's href. */
  url?: string | null;
  /** Human-readable job title (from the card heading text). */
  title?: string | null;
  /** Raw location text (from the card's location line). */
  location?: string | null;
  /** JSON-LD `jobLocation` PostalAddresses, when the board emits them. */
  addresses?: BizneoPostalAddress[] | null;
  /** Optional brand / sub-organisation label shown on the card (e.g. "PizzaHut"). */
  brand?: string | null;
  /** Raw work-mode token (e.g. "On-site", "Remote", "Hybrid"), when present. */
  workMode?: string | null;
}

/**
 * Minimal schema.org `JobPosting` shape, used only as an optional enrichment when
 * the board server-renders a JSON-LD block. All fields are optional and narrowed.
 */
export interface BizneoJobPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  industry?: string;
  jobLocationType?: string;
  url?: string;
  hiringOrganization?: string | { name?: string };
  jobLocation?: BizneoJobLocation | BizneoJobLocation[];
}

/** schema.org `jobLocation` node (or one element of a `jobLocation` array). */
export interface BizneoJobLocation {
  address?: BizneoPostalAddress;
}

/** schema.org `PostalAddress` shape (locality / region / country). */
export interface BizneoPostalAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string | { name?: string };
}

/**
 * Normalised view of a single Bizneo role, ready to map to a JobPostDto.
 */
export interface BizneoJob {
  /** The `{slug}` segment — used as the ATS id. */
  slug: string;

  /** Absolute public detail / apply URL (the canonical board job page). */
  url: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant / brand company display name. */
  companyName?: string | null;

  /** Structured location parts derived from the raw location text / JSON-LD. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** One `{city,state,country}` triple per JSON-LD `jobLocation` address, when present. */
  locationEntries?: Array<{ city: string | null; state: string | null; country: string | null }> | null;

  /** Raw single-line location string, used as the description fallback / remote signal. */
  locationText?: string | null;

  /** Department / industry label, when present. */
  department?: string | null;

  /** Employment-type label, when present. */
  employmentType?: string | null;

  /** Posted date — parsed when an absolute date is available (else null). */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;

  /** Optional HTML body recovered from a JSON-LD `description`, when present. */
  descriptionHtml?: string | null;
}
