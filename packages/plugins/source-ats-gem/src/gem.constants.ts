/**
 * Spec 006 / T05 — Gem GraphQL constants.
 *
 * Mirrors the upstream Python reference
 * (`OTHERS/Ats-scrapers/gem/scripts/gem_jobs_scraper/api_client.py`)
 * so a future contributor can `git diff` the two surfaces and
 * convince themselves the wire shape matches: the batched POST
 * carries both `JobBoardTheme` and `JobBoardList` operations, the
 * `batch: 'true'` header is what flips the server into batched
 * mode, and the operation order in the request payload matches the
 * upstream snippet exactly (Theme first, List second).
 *
 * Response-order tolerance is handled inside `GemService` itself —
 * the wire request is fixed; the server is allowed to reorder the
 * operations in its response and the parser picks the array entry
 * whose `data.oatsExternalJobPostings` is defined.
 */

/** Base URL — both API endpoint and `Origin` / `Referer` headers. */
export const GEM_BASE_URL = 'https://jobs.gem.com';

/** Single batched GraphQL endpoint that accepts both operations in one POST. */
export const GEM_API_ENDPOINT = `${GEM_BASE_URL}/api/public/graphql/batch`;

/**
 * `JobBoardTheme` GraphQL query — fetches branding theme for the
 * board. We don't render the theme, but the upstream Python sends
 * both queries so we mirror the wire shape exactly to avoid any
 * server-side heuristic that disqualifies "lone-list" requests.
 */
export const GEM_JOB_BOARD_THEME_QUERY = `
query JobBoardTheme($boardId: String!) {
  publicBrandingTheme(externalId: $boardId) {
    id
    theme
    __typename
  }
}
`;

/**
 * `JobBoardList` GraphQL query — fetches `oatsExternalJobPostings`
 * (the list of job postings) plus filters and company info. Field
 * set is pinned to upstream Python's `JOB_BOARD_LIST_QUERY` so
 * future schema drift surfaces as a parse error here, not as silent
 * field loss in the consumer.
 */
export const GEM_JOB_BOARD_LIST_QUERY = `
query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id
      extId
      title
      locations {
        id
        name
        city
        isoCountry
        isRemote
        extId
        __typename
      }
      job {
        id
        department {
          id
          name
          extId
          __typename
        }
        locationType
        employmentType
        __typename
      }
      __typename
    }
    __typename
  }
  oatsExternalJobPostingsFilters(boardId: $boardId) {
    type
    displayName
    rawValue
    value
    count
    __typename
  }
  jobBoardExternal(vanityUrlPath: $boardId) {
    id
    teamDisplayName
    descriptionHtml
    pageTitle
    __typename
  }
}
`;

/**
 * `ExternalJobPostingQuery` GraphQL query — fetches the per-posting
 * detail by `extId`. The list op (`oatsExternalJobPostings`) carries
 * no body/posted-date/pay, so each posting kept after the
 * `resultsWanted` cap is overlaid with this detail:
 *   - `descriptionHtml` — the full authored body (HTML).
 *   - `firstPublishedTsSec` — first-published Unix timestamp (seconds)
 *     → `datePosted`; `startDateTs` is a fallback.
 *   - `compensationHtml` — free-text pay block (e.g.
 *     "$170,000 – $200,000 per year"); Gem exposes no structured
 *     bounds, so this is parsed via the shared salary extractor.
 */
export const GEM_JOB_BOARD_DETAIL_QUERY = `
query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    descriptionHtml
    firstPublishedTsSec
    startDateTs
    compensationHtml
    __typename
  }
}
`;

/** Default `resultsWanted` cap when caller doesn't supply one. Matches AvatureService precedent. */
export const GEM_DEFAULT_RESULTS_WANTED = 100;

/** Max parallel detail fetches per board (bounded concurrency for the overlay). */
export const GEM_DETAIL_CONCURRENCY = 6;

/**
 * Gem `job.employmentType` enum → human-readable label. The list op
 * carries the enum (e.g. `FULL_TIME`); the label feeds `JobPostDto`
 * (`employmentType`) and `getJobTypeFromString` (which keys on the
 * de-spaced label, so `Full-time` → `JobType.FULL_TIME`). Unknown
 * values pass through verbatim.
 */
export const GEM_EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
  CONTRACTOR: 'Contract',
  INTERN: 'Internship',
  INTERNSHIP: 'Internship',
  TEMPORARY: 'Temporary',
  SEASONAL: 'Seasonal',
};

/**
 * Headers Gem expects on every request. `batch: 'true'` is the
 * flag that switches the server into batched-execution mode (an
 * empty / absent header silently degrades to non-batched, which
 * would split our single POST into two roundtrips).
 */
export const GEM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Content-Type': 'application/json',
  Origin: GEM_BASE_URL,
  Referer: GEM_BASE_URL,
  batch: 'true',
};
