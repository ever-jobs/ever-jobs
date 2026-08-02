/**
 * Spec 013 / T03 — Oracle HCM Cloud constants.
 *
 * Values mirror the upstream Python reference
 * (`OTHERS/Ats-scrapers/oracle/scripts/oracle_ats_client/api_client.py`)
 * so a future contributor can `git diff` the two and convince themselves
 * the wire format matches: page size 100, default `siteNumber`
 * `CX_45001`, the documented eight-facet list, and the comma /
 * semicolon separator pair the live API expects.
 */

/** Default `siteNumber` finder parameter (Spec 013 / Q-030 / FR-4). */
export const ORACLE_DEFAULT_SITE_NUMBER = 'CX_45001';

/**
 * Middle host segment used when composing a base URL from a bare pod
 * subdomain (the colon-slug form `{subdomain}:{siteNumber}` — Spec 5037).
 * Modern Oracle SaaS pods live under `…fa.ocs.oraclecloud.com` (the pod
 * identity is baked into the subdomain). Older tenants use a region code
 * (`us2`, `us6`, `us8`, …) here instead — those MUST be addressed by the
 * full-host slug form, since the region is not recoverable from the
 * subdomain alone. See `parseSlug`.
 */
export const ORACLE_DEFAULT_HOST_SEGMENT = 'ocs';

/** Page size for `recruitingCEJobRequisitions` pagination. Matches FR-2. */
export const ORACLE_RECORDS_PER_PAGE = 100;

/** Ceiling on jobs returned when `input.resultsWanted` is unset. */
export const ORACLE_DEFAULT_RESULTS_WANTED = 100;

/** Hard ceiling on pagination loops to prevent runaway scrapes. (`(default 100)/100 = 1` plus headroom for ResultsWanted overrides.) */
export const ORACLE_MAX_PAGES = 50;

/**
 * Default sort order for the finder string. `POSTING_DATES_DESC` is
 * upstream Python's default; FR-20 (stable `(site, externalId)`) is
 * unaffected by sort order, but newest-first improves dedup-engine
 * locality on incremental runs.
 */
export const ORACLE_DEFAULT_SORT_BY = 'POSTING_DATES_DESC';

/**
 * Eight-facet list documented in `tasks.md` T03 acceptance and
 * upstream Python's `search_jobs(facets=None)` default. Joined with
 * `;` to build the `facetsList=` finder parameter.
 */
export const ORACLE_DEFAULT_FACETS: readonly string[] = [
  'LOCATIONS',
  'WORK_LOCATIONS',
  'WORKPLACE_TYPES',
  'TITLES',
  'CATEGORIES',
  'ORGANIZATIONS',
  'POSTING_DATES',
  'FLEX_FIELDS',
] as const;

/**
 * Default `expand=` query parameter. Mirrors upstream Python's
 * `search_jobs` endpoint string verbatim — these expansions populate
 * the `WorkLocation` / `OtherWorkLocations` / `RequisitionFlexFields`
 * sub-objects we read in `toJobPost()`.
 */
export const ORACLE_DEFAULT_EXPAND =
  'requisitionList.workLocation,' +
  'requisitionList.otherWorkLocations,' +
  'requisitionList.secondaryLocations,' +
  'flexFieldsFacet.values,' +
  'requisitionList.requisitionFlexFields';

/** Finder name used by the live Oracle API (matches upstream Python). */
export const ORACLE_FINDER_NAME = 'findReqs';

/** REST resource path used by the live Oracle API (matches upstream Python). */
export const ORACLE_REST_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';

/** Browser-shaped headers so Oracle returns the same payload it would to a real visitor. Matches upstream Python's `session.headers`. */
export const ORACLE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Sentinel error codes (Spec 013 / § 7.3). Recorded via the service
 * logger when the corresponding failure mode is detected. They are
 * NOT thrown — `scrape()` always resolves with an empty
 * `JobResponseDto` per FR-12 / `AGENTS.md §10`.
 */
export const ORACLE_ERR_BAD_TENANT = 'ERR_ORACLE_BAD_TENANT';
export const ORACLE_ERR_FINDER_REJECTED = 'ERR_ORACLE_FINDER_REJECTED';
