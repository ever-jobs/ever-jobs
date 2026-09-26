/** The two published lists. */
export type SimplifyFeedKind = 'newgrad' | 'internships';

/**
 * One row of a `listings.json` feed as published (a JSON array of these).
 * Every field is optional here: rows are validated one by one and a bad row
 * is dropped, never trusted.
 */
export interface SimplifyRawRow {
  /** UUID, unique per row. */
  id?: unknown;
  /** Who added the row. Never ingested. */
  source?: unknown;
  /** `Software`, `AI/ML/Data`, `Quant`, `Hardware`, `Product`; older rows use long forms. */
  category?: unknown;
  company_name?: unknown;
  title?: unknown;
  /** Only `true` rows are live. */
  active?: unknown;
  /** Internships only, e.g. `['Summer 2027']`, `['N/A']`. */
  terms?: unknown;
  /** Unix epoch SECONDS; a multiple of 86 400 means only the day is known. */
  date_posted?: unknown;
  /** Unix epoch seconds. */
  date_updated?: unknown;
  /** The employer's own apply URL. */
  url?: unknown;
  /** Free-text labels (`Austin, TX`, `Remote in USA`, `NYC`). */
  locations?: unknown;
  /** `https://simplify.jobs/c/<slug>`. */
  company_url?: unknown;
  /** `false` hides the row; a missing value means visible. */
  is_visible?: unknown;
  sponsorship?: unknown;
  degrees?: unknown;
}

/** Normalised visa-sponsorship statement (not yet a `JobPostDto` field; see Spec 1694 D-08). */
export type SimplifyVisaSponsorship = 'offered' | 'not_offered' | 'citizenship_required';

/**
 * A live row compacted to the fields we map. This is what the cache holds, so
 * it stays small: repeated strings (company, location, term, category) are
 * shared across rows; the `source` field (who added the row) and degrees are dropped.
 */
export interface SimplifyRow {
  id: string;
  feed: SimplifyFeedKind;
  title: string;
  companyName: string;
  /** Simplify's company page, or null. */
  companyUrl: string | null;
  /** Normalised category (see `normalizeCategory`), or null. */
  category: string | null;
  /** Terms with `N/A` removed; frozen and shared. */
  terms: readonly string[];
  /** Epoch seconds, or null when missing or unusable. */
  datePosted: number | null;
  /** Epoch seconds, or null. */
  dateUpdated: number | null;
  /** The employer apply URL, trimmed. */
  url: string;
  /** Raw location labels, trimmed; frozen and shared. */
  locations: readonly string[];
  sponsorship: SimplifyVisaSponsorship | null;
}

/** Facts about one location label, used only for filtering. */
export interface SimplifyLocationFacts {
  /** Folded text a location query is matched against: labels, parsed parts, inferred country. */
  haystack: string;
  /** Canonical country names the label names or implies. */
  countries: readonly string[];
  /** Upper-case state / province codes. */
  states: readonly string[];
  remote: boolean;
}

/** Per-feed outcome of one scrape, for logging and diagnostics. */
export interface SimplifyFeedOutcome {
  feed: SimplifyFeedKind;
  /** `cache` (fresh, no request), `revalidated` (304), `fetched` (200), `stale` (error, old copy served). */
  source: 'cache' | 'revalidated' | 'fetched' | 'stale' | 'failed';
  rows: number;
  ageMs?: number;
  error?: unknown;
}
