/**
 * Default number of Upwork job results to fetch.
 */
export const DEFAULT_NUM_RESULTS = 20;

/**
 * Default sort field for job search results.
 * RECENCY returns the most recently posted jobs first.
 */
export const DEFAULT_SORT_FIELD = 'RECENCY';

/**
 * GraphQL query for searching Upwork marketplace job postings.
 *
 * Uses the `marketplaceJobPostings` query which is the current
 * supported method after deprecation of the REST search endpoint.
 *
 * Available fields on each node:
 *   id, title, description, createdDateTime,
 *   ciphertext (used to build the job URL),
 *   duration, engagement, amount { amount, currencyCode },
 *   category { name }, subcategory { name },
 *   skills { name }, client { totalPostedJobs, totalHires },
 *   weeklyBudget { amount, currencyCode },
 *   contractorTier (ENTRY, INTERMEDIATE, EXPERT)
 */
export const JOB_SEARCH_QUERY = `
  query JobSearch($searchTerm: String, $first: Int, $sortField: MarketplaceJobPostingSortField) {
    marketplaceJobPostings(
      marketPlaceJobFilter: {
        searchTerm_eq: { andTerms_all: $searchTerm }
      }
      searchType: USER_JOBS_SEARCH
      sortAttributes: { field: $sortField, sortOrder: DESC }
      pagination: { first: $first }
    ) {
      totalCount
      edges {
        node {
          id
          ciphertext
          title
          description
          createdDateTime
          duration
          engagement
          amount {
            amount
            currencyCode
          }
          weeklyBudget {
            amount
            currencyCode
          }
          category {
            name
          }
          subcategory {
            name
          }
          skills {
            name
          }
          client {
            totalPostedJobs
            totalHires
          }
          contractorTier
        }
      }
    }
  }
`;

// ── OAuth2 / GraphQL endpoints ──────────────────────────────
//
// Transcribed from `@upwork/node-upwork-oauth2@2.3.0` (`lib/config.js`) so the
// direct client below is wire-compatible with the SDK it replaces. The SDK is
// NOT a dependency — its latest release (2.3.0, 2024-11-27) still pins
// `request@2.88.2`, whose advisories have no upstream fix.

/** OAuth2 token host — `Config.tokenHost` in the SDK. */
export const UPWORK_TOKEN_HOST = 'https://www.upwork.com';

/** OAuth2 token path — `Config.tokenPath` in the SDK. */
export const UPWORK_TOKEN_PATH = '/api/v3/oauth2/token';

/** Full token endpoint. */
export const UPWORK_TOKEN_URL = `${UPWORK_TOKEN_HOST}${UPWORK_TOKEN_PATH}`;

/** GraphQL endpoint — `Config.gqlUrl` in the SDK. */
export const UPWORK_GRAPHQL_URL = 'https://api.upwork.com/graphql';

/**
 * 🛑 Credentials go in the request BODY, not an `Authorization: Basic` header.
 *
 * The SDK configures simple-oauth2 with `options.authorizationMethod = 'body'`
 * (`lib/client.js`). Upwork's token endpoint is built around that, so sending
 * Basic auth instead yields 401 — this is the single easiest thing to get wrong
 * when replacing the SDK, hence the constant rather than an inline literal.
 */
export const UPWORK_AUTHORIZATION_METHOD = 'body' as const;

/** Seconds of slack applied before treating an access token as expired. */
export const UPWORK_TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** Default request timeout (seconds) for token + GraphQL calls. */
export const UPWORK_DEFAULT_TIMEOUT_SECONDS = 30;
