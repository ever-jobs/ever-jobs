/**
 * Types for the Wellfound aggregator search (Spec 1708).
 *
 * Verified against live landing pages (`/role/l/{role}/{location}`,
 * `/role/r/{role}?page=N`): the server-rendered `#__NEXT_DATA__` JSON holds a
 * normalized Apollo cache at `props.pageProps.apolloState.data`, a flat map
 * keyed `"<__typename>:<id>"`. Fields are primitives, inline objects or
 * `{__ref}` pointers into the same map.
 */

/** A pointer into the Apollo cache. */
export interface ApolloRef {
  __ref: string;
}

/** Any node of the normalized cache. */
export interface ApolloEntity {
  __typename?: string;
  id?: string | number;
  [key: string]: unknown;
}

/** `props.pageProps.apolloState.data`. */
export type ApolloCache = Record<string, ApolloEntity>;

/** The `#__NEXT_DATA__` document. */
export interface WellfoundNextData {
  /** Next.js route, e.g. `/seoLanding/roleLocationSearch`; `/_error` for a not-found page. */
  page?: string;
  /** Route parameters, e.g. `{ role: 'software-engineer', location: 'san-francisco' }`. */
  query?: Record<string, unknown>;
  props?: {
    pageProps?: {
      apolloState?: {
        data?: ApolloCache;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * `ROOT_QUERY.talent["seoLandingPageJobSearchResults(<json args>)"]`: one
 * page of companies, in the site's ranking order.
 */
export interface WellfoundSearchResultsConnection {
  __typename?: string;
  totalStartupCount?: number;
  totalJobCount?: number;
  perPage?: number;
  pageCount?: number;
  startups?: ApolloRef[];
}

/**
 * `JobListingRemoteConfig`. Inline on landing-page results, a `{__ref}` on
 * the `/jobs` feed and company boards.
 */
export interface WellfoundRemoteConfig {
  __typename?: 'JobListingRemoteConfig' | string;
  id?: string;
  /** `ONSITE`, `ONSITE_OR_REMOTE`, `REMOTE` (and `REMOTE_ONLY` on some payloads). */
  kind?: string | null;
  wfhFlexible?: boolean | null;
}

/**
 * Fields of the listing shape this plugin assumed before Spec 1708. None of
 * them has been observed on a live page; they are still read as fallbacks so a
 * payload that does carry them maps as it would have before.
 */
export interface WellfoundLegacyListingFields {
  company?: {
    name?: string;
    slug?: string;
    logoUrl?: string;
    highConcept?: string;
    companySize?: string;
  } | null;
  locations?: string[];
  skills?: string[];
  createdAt?: string;
}

/** Pre-Spec-1708 structured compensation. The live field is a string. */
export interface WellfoundLegacyCompensation {
  min?: number | null;
  max?: number | null;
  currency?: string;
  equity?: boolean;
  equityMin?: number | null;
  equityMax?: number | null;
}

/** Fields shared by both listing node types. */
interface WellfoundListingBase extends WellfoundLegacyListingFields {
  id: string | number;
  title?: string;
  slug?: string;
  /** `"full-time"` observed. */
  jobType?: string | null;
  /** Posting time, epoch **seconds**. */
  liveStartAt?: number | string | null;
  /** May be empty, and may contain `"Remote"`. */
  locationNames?: string[] | null;
  acceptedRemoteLocationNames?: string[] | null;
  /** The site's own "remote-eligible" flag. */
  remote?: boolean | null;
  remoteConfig?: WellfoundRemoteConfig | ApolloRef | null;
  primaryRoleTitle?: string | null;
  /**
   * Preformatted: a range with an en dash (U+2013) between the bounds, an
   * optional trailing ISO code (`CAD`), then optionally a bullet (U+2022) and
   * the equity range. May be `""`. The pre-Spec-1708 object form is still
   * accepted.
   */
  compensation?: string | WellfoundLegacyCompensation | null;
  yearsExperienceMin?: number | null;
  yearsExperienceMax?: number | null;
  /** Upstream ATS of an imported listing. Kept for a future origin-ATS field; not mapped to `atsType`. */
  atsSource?: string | null;
  autoPosted?: boolean | null;
  [key: string]: unknown;
}

/** A landing-page search result. `description` is Markdown, the full body. */
export interface WellfoundJobListingSearchResult extends WellfoundListingBase {
  __typename?: 'JobListingSearchResult';
  description?: string | null;
}

/** A `/jobs` feed or company-board node: an HTML snippet and a company ref. */
export interface WellfoundJobListing extends WellfoundListingBase {
  __typename?: 'JobListing';
  description?: string | null;
  descriptionSnippet?: string | null;
  startup?: ApolloRef | null;
}

/** Either listing node. */
export type WellfoundAnyListing = WellfoundJobListingSearchResult | WellfoundJobListing;

/**
 * The listing shape of the pre-Spec-1708 plugin, kept as an alias so existing
 * imports keep compiling.
 */
export type WellfoundListing = WellfoundAnyListing;

/** `StartupResult` (landing pages) or `Startup` (feed and boards). */
export interface WellfoundStartupResult {
  __typename?: 'StartupResult' | 'Startup';
  id?: string | number;
  name?: string | null;
  slug?: string | null;
  logoUrl?: string | null;
  /** Tagline. */
  highConcept?: string | null;
  /** `SIZE_1_10` to `SIZE_1001_5000`, or `SIZE_<n>_PLUS`. */
  companySize?: string | null;
  badges?: ApolloRef[];
  highlightedJobListings?: ApolloRef[];
  [key: string]: unknown;
}

/** One listing with its company and resolved remote config, in site order. */
export interface WellfoundListingPair {
  listing: WellfoundAnyListing;
  startup: WellfoundStartupResult | null;
  remoteConfig: WellfoundRemoteConfig | null;
}
