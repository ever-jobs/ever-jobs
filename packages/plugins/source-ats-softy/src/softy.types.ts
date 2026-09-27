/**
 * TypeScript interfaces for the Softy (softy.pro) public careers surface.
 *
 * Softy's candidate-facing careers board (`https://{tenant}.softy.pro/offers?page=N`,
 * legacy `/offres`) is a server-rendered HTML index, with a `/sitemap.xml` listing
 * every offer — there is no public JSON wire shape to model. The interfaces below
 * describe the fragments the adapter parses out of each job card on the index (the
 * current `/offers/{ID}` card with its `data-slot` fields, or the legacy
 * `/offre/{ID}-{title-slug}` anchor plus the labelled text around it), the fields
 * read from a detail page, and the normalised internal role assembled from them.
 * Everything the adapter reads is optional and defensively narrowed at parse time, so
 * cross-tenant or future-layout drift never breaks the parser.
 */

import type { SoftyLegacyToken, SoftySitemapFallback } from './softy.constants';

/**
 * A single role as parsed out of the index HTML (or, in sitemap discovery, out of a
 * sitemap entry + its detail page). Current markup: an `/offers/{ID}` card with
 * `data-slot` title / locations / badges / published-at. Legacy markup: a detail
 * anchor (`/offre/{ID}-{title-slug}`) plus the labelled card text immediately
 * surrounding it (title heading, location city, contract type, "Mise en ligne le
 * DD/MM/YYYY").
 */
export interface SoftyCardJob {
  /** Numeric Softy job id — the `{ID}` URL segment (e.g. `208303`). The ATS id. */
  id: string;
  /** Title slug — the trailing `{title-slug}` URL segment (legacy markup only). */
  slug?: string | null;
  /** Absolute canonical detail / apply URL parsed from the anchor's href. */
  url?: string | null;
  /** Human-readable job title (from the card heading text, else de-slugified). */
  title?: string | null;
  /** Raw location text (the work-location city, e.g. "Toulouse"). */
  location?: string | null;
  /** Raw contract-type text (e.g. "CDI", "Apprentissage - 24 Mois"). */
  contractType?: string | null;
  /** Raw "Mise en ligne le DD/MM/YYYY" published-date text, when present. */
  publishedAt?: string | null;

  /** Every location line on the card (`[data-slot=joboffer-locations] p`), current markup. */
  locations?: string[] | null;

  /** Working-time badge (e.g. "Temps plein"), current markup. */
  schedule?: string | null;

  /** All badge texts (`[data-slot=badge]`), current markup. */
  badges?: string[] | null;

  /** Parsed sitemap `<lastmod>` of the offer (sitemap discovery only). */
  lastmod?: Date | null;

  /** True when the card came from the legacy `/offres` markup parser. */
  legacy?: boolean;
}

/**
 * Fields extracted from a detail page (`/offers/{ID}`, or a legacy `/offre/{ID}-{slug}`
 * page). This — never the raw page — is what the detail cache stores.
 */
export interface SoftyDetail {
  /** `h1`, else `og:title`, else `<title>`. */
  title?: string | null;
  /** `[data-slot=joboffer-locations] p` texts. */
  locations: string[];
  /** Contract badge (CDI, CDD, Stage…). */
  contractType?: string | null;
  /** Working-time badge (Temps plein / partiel…). */
  schedule?: string | null;
  /** All badge texts. */
  badges: string[];
  /** "Mise en ligne le …" text, if the page ever carries one. */
  publishedAt?: string | null;
  /**
   * Description body, at most `SOFTY_DESCRIPTION_MAX_CHARS`: cleaned HTML of the
   * `.prose` sections with their `h2` headings when `descriptionIsHtml`, otherwise
   * plain text (`og:description`, or the whole page's text for legacy pages).
   */
  description?: string | null;
  descriptionIsHtml: boolean;
}

/** Effective per-scrape knobs (constants overridden by environment variables). */
export interface SoftyConfig {
  /** Listing pages read at most (>= 0; 0 disables list pages, Spec 1715 FR-11). */
  maxListPages: number;
  /** Detail pages fetched at most (>= 0; cache hits do not count). */
  maxDetailFetches: number;
  /** Detail-cache entries (0 disables the cache). */
  detailCacheMax: number;
  /**
   * Detail-cache TTL in ms of sitemap entries (0 = no expiry): `SOFTY_DETAIL_CACHE_TTL_MS`
   * when set, else `SOFTY_DETAIL_CACHE_TTL_MS` the constant (0, Spec 1715 FR-13).
   */
  detailCacheTtlMs: number;
  /**
   * Detail-cache TTL in ms of listing entries (derived, Spec 1715 FR-13): the env value
   * when `SOFTY_DETAIL_CACHE_TTL_MS` is set, else `SOFTY_LISTING_DETAIL_CACHE_TTL_MS` (6 h).
   */
  listingDetailCacheTtlMs: number;
  /** Use the sitemap `<lastmod>` date as `datePosted` when the page has none. */
  lastmodAsDatePosted: boolean;
  /** Stop after this many consecutive failed detail fetches (0 = never). */
  maxConsecutiveDetailFailures: number;
  /** When `auto` may fall back from the sitemap to list pages (Spec 1715 FR-4). */
  sitemapFallback: SoftySitemapFallback;
  /** Negative-cache TTL of an unknown tenant, ms (0 disables; Spec 1715 FR-5). */
  unknownTenantTtlMs: number;
  /** Detail GETs are capped at `resultsWanted + detailAttemptSlack` (Spec 1715 FR-7). */
  detailAttemptSlack: number;
  /** Per-tenant sitemap cache TTL, ms (0 disables; Spec 1715 FR-12). */
  sitemapCacheTtlMs: number;
  /** `minIntervalFloorMs` of the Softy client: 1000, or 0 with `SOFTY_LEGACY=no-interval-floor` (derived). */
  minIntervalFloorMs: number;
  /** The `SOFTY_LEGACY` tokens in force (Spec 1715 FR-17). */
  legacy: ReadonlySet<SoftyLegacyToken>;
}

/**
 * Normalised view of a single Softy role, ready to map to a JobPostDto.
 */
export interface SoftyJob {
  /** Numeric Softy job id — used as the ATS id. */
  jobId: string;

  /** Absolute public detail / apply URL (`/offers/{ID}`; legacy `/offre/{ID}-{slug}`). */
  url: string;

  /** Job display title. */
  title?: string | null;

  /** Tenant company display name (derived from the slug — the card carries no brand name). */
  companyName?: string | null;

  /** Structured location parts derived from the raw location text. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** Raw single-line location string, used as a remote signal and listing fallback. */
  locationText?: string | null;

  /** Employment-type label (from the contract-type text). */
  employmentType?: string | null;

  /** Posted date — parsed from "Mise en ligne le …" into YYYY-MM-DD, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / télétravail. */
  isRemote?: boolean | null;

  /** Job-body description text recovered best-effort from the detail page. */
  description?: string | null;

  /** True when `description` is HTML (the `.prose` sections) rather than plain text. */
  descriptionIsHtml?: boolean;

  /** Working-time label (e.g. "Temps plein"), when the page shows one. */
  schedule?: string | null;
}
