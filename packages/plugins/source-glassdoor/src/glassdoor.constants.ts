import { Country } from '@ever-jobs/models';

/**
 * The client-wide header map every request carried before Spec 1703. Still the
 * single source of the header VALUES (the per-request maps below are picked
 * from it), and still applied client-wide in the `headers` legacy mode.
 */
export const GLASSDOOR_HEADERS: Record<string, string> = {
  authority: 'www.glassdoor.com',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://www.glassdoor.com',
  referer: 'https://www.glassdoor.com/',
  'sec-ch-ua': '"Not_A Brand";v="99", "Google Chrome";v="120", "Chromium";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export const FALLBACK_CSRF_TOKEN = 'test-csrf-token';

export const GD_JOB_SEARCH_QUERY = `
query JobSearchQuery(
  $keyword: String
  $locationId: Int
  $locationType: LocationTypeEnum
  $numPerPage: Int
  $pageCursor: String
  $filterParams: [FilterParamInput]
  $originalPageUrl: String
  $seoUrl: Boolean
) {
  jobListings(
    contextHolder: {
      searchParams: {
        keyword: $keyword
        locationId: $locationId
        locationType: $locationType
        numPerPage: $numPerPage
        pageCursor: $pageCursor
        filterParams: $filterParams
        originalPageUrl: $originalPageUrl
        seoUrl: $seoUrl
      }
    }
  ) {
    companyFilterOptions { id shortName }
    filterOptions { filterKey options { id label } }
    indeedCtk
    jobListingSeoLinks { linkItems { position url } }
    paginationCursors { cursor pageNumber }
    indexablePageCount
    searchResultsMetadata {
      searchCriteria { keyword impliedKeyword locationId locationType pageNumber seoFriendlyUrlInput }
      footerVO { countryMenu { childNavigationLinks { id link textKey } } }
      helpCenterDomain helpCenterLocale searchId
    }
    jobListings {
      jobview {
        header {
          adOrderId adOrderSponsorshipLevel ageInDays divisionEmployerName easyApply employer { id name shortName }
          employerNameFromSearch goc jobCountryId jobLink jobResultTrackingKey jobTitleId jobTitleText locId
          locationName locationType lowQualityApply payCurrency payPeriod payPeriodAdjustedPay { p10 p50 p90 }
          rating savedJobId seoJobLink sponsored normalizedJobTitle
        }
        job { descriptionFragments importConfigId jobTitleId jobTitleText listingId }
        overview { id name shortName squareLogoUrl }
      }
    }
  }
}`;

// --- Spec 1703: robots-neutral hardening -----------------------------------

/** Rows the search endpoint returns per page (the `numPerPage` we send). */
export const GLASSDOOR_PAGE_SIZE = 30;

/**
 * Default page cap: about 900 reachable rows. The loop before Spec 1703 had no
 * cap at all and could re-request page 1 forever once the cursors ran out.
 */
export const GLASSDOOR_MAX_PAGES = 30;

/** Ceiling for {@link GLASSDOOR_MAX_PAGES_ENV}; a larger value is clamped to it. */
export const GLASSDOOR_HARD_MAX_PAGES = 100;

/** `resultsWanted` when the caller gives none (unchanged from before Spec 1703). */
export const GLASSDOOR_DEFAULT_RESULTS = 15;

/**
 * The site's "Remote" pseudo-location. It is reported with `locationType`
 * `S` (STATE), which is why `locationType === 'S'` alone is not a remote
 * signal: every state-level listing ("California") carries it too.
 */
export const REMOTE_PSEUDO_LOCATION_ID = 11047;

/** Longest GraphQL error text carried in a diagnostics detail. */
export const GRAPH_ERROR_DETAIL_MAX = 280;

/** Appended to diagnostics when the homepage yielded no CSRF token. */
export const NO_CSRF_TOKEN_NOTE = '(no csrf token extracted)';

/** Detail of the one-per-run debug line when `input.location` is post-filtered. */
export const LOCATION_POST_FILTER_NOTE = 'location applied as post-filter (site-side scoping unavailable)';

function pickHeaders(keys: readonly string[]): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const key of keys) picked[key] = GLASSDOOR_HEADERS[key];
  return Object.freeze(picked);
}

/**
 * Headers for the homepage GET (the CSRF-token fetch). An HTML document is
 * requested as one: no JSON `content-type`, no CORS fetch metadata and no
 * client hints. Nothing here is new; it is a subset of what that request
 * carried before, plus an honest HTML `accept`.
 */
export const GLASSDOOR_DOCUMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': GLASSDOOR_HEADERS['accept-language'],
});

/**
 * Headers for the search POST: exactly the values it carried before Spec 1703,
 * minus `authority` (an HTTP/2 pseudo-header an HTTP client cannot send) and
 * minus `origin` / `referer`, which are now derived from the country domain.
 */
export const GLASSDOOR_API_HEADERS = pickHeaders([
  'accept',
  'accept-language',
  'content-type',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
]);

/**
 * Client hints describing the default browser User-Agent. Sent on the search
 * POST only when the caller did not supply its own `userAgent`, so they never
 * contradict the UA that actually goes out.
 */
export const GLASSDOOR_CLIENT_HINT_HEADERS = pickHeaders([
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);

/**
 * Currency to assume when a listing carries pay data but no `payCurrency`.
 * Before Spec 1703 this was always `USD`, which is wrong on every regional
 * domain. Countries not listed keep `USD`.
 */
export const GLASSDOOR_FALLBACK_CURRENCY: Readonly<Partial<Record<Country, string>>> = Object.freeze({
  [Country.ARGENTINA]: 'ARS',
  [Country.AUSTRALIA]: 'AUD',
  [Country.AUSTRIA]: 'EUR',
  [Country.BELGIUM]: 'EUR',
  [Country.BRAZIL]: 'BRL',
  [Country.CANADA]: 'CAD',
  [Country.FRANCE]: 'EUR',
  [Country.GERMANY]: 'EUR',
  [Country.HONGKONG]: 'HKD',
  [Country.INDIA]: 'INR',
  [Country.IRELAND]: 'EUR',
  [Country.ITALY]: 'EUR',
  [Country.MALAYSIA]: 'MYR',
  [Country.MALTA]: 'EUR',
  [Country.MEXICO]: 'MXN',
  [Country.NETHERLANDS]: 'EUR',
  [Country.NEWZEALAND]: 'NZD',
  [Country.SINGAPORE]: 'SGD',
  [Country.SPAIN]: 'EUR',
  [Country.SWITZERLAND]: 'CHF',
  [Country.UK]: 'GBP',
  [Country.USA]: 'USD',
  [Country.VIETNAM]: 'VND',
});

/**
 * Restores pre-Spec-1703 behaviour. `true` / `1` / `yes` / `on` / `all`
 * restores every behaviour in {@link GLASSDOOR_LEGACY_BEHAVIOURS}; a
 * comma-separated list of those names restores only the ones named (for
 * example `ids,job-url`). Unknown names are ignored. Read on every scrape.
 *
 * The bounded pagination is NOT covered: the loop it replaced could only
 * re-request page 1 without end, so it has no reachable result to restore.
 * {@link GLASSDOOR_MAX_PAGES_ENV} raises the cap instead.
 */
export const GLASSDOOR_LEGACY_ENV = 'EVER_JOBS_GLASSDOOR_LEGACY';

/**
 * Positive integer overriding {@link GLASSDOOR_MAX_PAGES}, clamped to
 * {@link GLASSDOOR_HARD_MAX_PAGES}. Anything else (unset, blank, zero,
 * negative, non-numeric) keeps the default. Read on every scrape.
 */
export const GLASSDOOR_MAX_PAGES_ENV = 'EVER_JOBS_GLASSDOOR_MAX_PAGES';

/**
 * Each pre-Spec-1703 behaviour that {@link GLASSDOOR_LEGACY_ENV} can restore:
 *
 * - `challenge`: a challenged homepage is only logged, and the search is
 *   still sent (one wasted request per blocked run).
 * - `ids`: `id` is `gd-<adOrderId>` (falling back to the listing id), and
 *   rows are de-duplicated on it, so listings sharing an ad order collapse.
 * - `job-url`: `jobUrl` is the listing's SEO link instead of the canonical
 *   `job-listing/j?jl=<listingId>` URL.
 * - `remote`: `isRemote` is `locationType === 'S'` (true for every
 *   state-level listing).
 * - `location-filter`: `input.location` is ignored.
 * - `headers`: {@link GLASSDOOR_HEADERS} is applied client-wide to every
 *   request, including the homepage GET.
 * - `listing-type`: `listingType` is `sponsored` or `null` only.
 * - `currency`: a missing `payCurrency` always means `USD`.
 */
export const GLASSDOOR_LEGACY_BEHAVIOURS = [
  'challenge',
  'ids',
  'job-url',
  'remote',
  'location-filter',
  'headers',
  'listing-type',
  'currency',
] as const;

export type GlassdoorLegacyBehaviour = (typeof GLASSDOOR_LEGACY_BEHAVIOURS)[number];

export interface GlassdoorRunOptions {
  /** Behaviours running in their pre-Spec-1703 form. Empty by default. */
  legacy: ReadonlySet<GlassdoorLegacyBehaviour>;
  /** Most search pages one scrape may request. */
  maxPages: number;
}

const LEGACY_ALL_VALUES = new Set(['true', '1', 'yes', 'on', 'all']);

/** Read {@link GLASSDOOR_LEGACY_ENV} and {@link GLASSDOOR_MAX_PAGES_ENV}. Never throws. */
export function readGlassdoorOptions(env: NodeJS.ProcessEnv = process.env): GlassdoorRunOptions {
  const legacy = new Set<GlassdoorLegacyBehaviour>();
  const rawLegacy = env[GLASSDOOR_LEGACY_ENV]?.trim().toLowerCase() ?? '';
  if (LEGACY_ALL_VALUES.has(rawLegacy)) {
    for (const name of GLASSDOOR_LEGACY_BEHAVIOURS) legacy.add(name);
  } else if (rawLegacy) {
    const known = new Set<string>(GLASSDOOR_LEGACY_BEHAVIOURS);
    for (const part of rawLegacy.split(',')) {
      const name = part.trim();
      if (known.has(name)) legacy.add(name as GlassdoorLegacyBehaviour);
    }
  }

  let maxPages = GLASSDOOR_MAX_PAGES;
  const rawPages = env[GLASSDOOR_MAX_PAGES_ENV]?.trim() ?? '';
  if (/^\d{1,6}$/.test(rawPages)) {
    const parsed = Number(rawPages);
    if (parsed > 0) maxPages = Math.min(parsed, GLASSDOOR_HARD_MAX_PAGES);
  }

  return { legacy, maxPages };
}
