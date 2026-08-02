/**
 * Constants for the Paycom applicant-tracking / careers platform.
 *
 * Paycom (paycom.com, US) is an enterprise payroll + HCM vendor whose
 * candidate-facing careers product is served from the `paycomonline.net` job
 * board. The board is multi-tenant and clientkey-addressed: every customer
 * publishes a public, unauthenticated careers site keyed by a 32-character hex
 * `clientkey`, e.g.
 *
 *   https://www.paycomonline.net/v4/ats/web.php/portal/{CLIENTKEY}/career-page
 *
 * The board is a client-rendered React app (a no-JS fetch of `/career-page`
 * returns only a `Loading…` shell), so the stable crawlable surface is the
 * board's JSON API rather than the HTML. The React app boots a public,
 * read-only bearer token (a JWT) into the page and then talks to the
 * applicant-tracking JSON API:
 *
 *  1. Bootstrap — fetch the clientkey-addressed board page and read the bearer
 *     token the app embeds for its own API calls:
 *
 *       GET https://www.paycomonline.net/v4/ats/web.php/portal/{KEY}/career-page
 *         → HTML carrying a `"sessionJWT":"{JWT}"` value (inside the page's
 *           `configsFromHost` bootstrap object) the React app forwards to the
 *           JSON API below. No login / candidate account is required — the token
 *           is public, page-embedded, and read-only.
 *
 *  2. Listing — POST the job-posting-previews search to enumerate open roles.
 *     The endpoint returns an EMPTY set unless the full `filtersForQuery` object
 *     is sent alongside `skip`/`take` (a bare `{skip,take}` yields zero):
 *
 *       POST https://portal-applicant-tracking.us-cent.paycomonline.net
 *              /api/ats/job-posting-previews/search
 *         Authorization: Bearer {JWT}
 *         { "skip": 0, "take": {n}, "filtersForQuery": { … } }
 *         → { "jobPostingPreviews": [ { "jobId": 60339,
 *             "jobTitle": "Production Technician", "locations": "Seymour, IN …",
 *             "remoteType": "", … } ], "jobPostingPreviewsCount": N }
 *
 *  3. Detail — GET a single posting for its full HTML body + Google-for-Jobs
 *     schema.org `JobPosting` JSON-LD. The payload is WRAPPED in `jobPosting`:
 *
 *       GET https://portal-applicant-tracking.us-cent.paycomonline.net
 *             /api/ats/job-postings/{jobId}
 *         Authorization: Bearer {JWT}
 *         → { "jobPosting": { "jobTitle": "…", "location": "…",
 *             "positionType": "Full Time", "jobCategory": "Manufacturing",
 *             "description": "<p>…</p>", "qualifications": "<ul>…</ul>",
 *             "salaryRange": "", "googleJobJson": "{…schema.org JobPosting…}" } }
 *
 *  4. Company name — the tenant's display name is behind a separate endpoint
 *     (it is NOT derivable from the clientkey):
 *
 *       GET https://portal-applicant-tracking.us-cent.paycomonline.net
 *             /api/ats/company-name
 *         Authorization: Bearer {JWT}
 *         → { "companyName": "Guardian Bikes" }
 *
 * `datePosted` is carried ONLY inside each detail's `googleJobJson` schema.org
 * string (the preview `postedOn` and detail `startDate` are empty), so the
 * adapter parses that JSON-LD node for the date, canonical URL, and any
 * structured `baseSalary`.
 *
 * The search API returns the tenant's full open-roles set (paged by skip/take),
 * so we request up to `resultsWanted` in one page and slice client-side. An
 * unknown clientkey (HTTP 4xx), a missing token, or a non-JSON payload degrades
 * to an empty (graceful) result rather than throwing, so a single bad tenant
 * never breaks a batch run.
 *
 * Surface confidence (verified 2026-06-30 against five live tenants — Boxabl,
 * Spudnik, Guardian Bikes, Aperture, Prefix — via a read-only probe): the
 * board → `sessionJWT` → search/detail/company-name API contract above is
 * confirmed end-to-end (verified=true).
 */

/** Canonical board origin (the public, clientkey-addressed careers host). */
export const PAYCOM_BOARD_ORIGIN = 'https://www.paycomonline.net';

/** Root board domain — used to recognise board URLs passed via `companyUrl`. */
export const PAYCOM_ROOT_DOMAIN = 'paycomonline.net';

/** Alternate board domain some legacy tenants are served from. */
export const PAYCOM_ALT_DOMAINS = ['paycomonline.com'];

/** Origin of the applicant-tracking JSON API the React board calls. */
export const PAYCOM_API_ORIGIN =
  'https://portal-applicant-tracking.us-cent.paycomonline.net';

/** Job-posting-previews search endpoint (POST {skip,take,filtersForQuery}). */
export const PAYCOM_API_SEARCH_PATH = '/api/ats/job-posting-previews/search';

/** Single job-posting endpoint (GET); returns `{ jobPosting: {…} }`. */
export const PAYCOM_API_DETAIL_PATH = '/api/ats/job-postings';

/** Tenant display-name endpoint (GET); returns `{ companyName }`. */
export const PAYCOM_API_COMPANY_NAME_PATH = '/api/ats/company-name';

/**
 * Build the clientkey-addressed board page URL. The board page boots the
 * `sessionJWT` the API calls require.
 */
export function paycomBoardUrl(clientkey: string): string {
  return `${PAYCOM_BOARD_ORIGIN}/v4/ats/web.php/portal/${encodeURIComponent(clientkey)}/career-page`;
}

/** Build a public per-job detail / apply URL for a role. */
export function paycomJobUrl(clientkey: string, jobId: string): string {
  return `${PAYCOM_BOARD_ORIGIN}/v4/ats/web.php/portal/${encodeURIComponent(clientkey)}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: the public DTO
 * default is small, but when a caller omits `resultsWanted` entirely we ingest
 * up to 100 of the tenant's open roles.
 */
export const PAYCOM_DEFAULT_RESULTS = 100;

/** Default request headers. The board / API expect a browser-like UA + JSON. */
export const PAYCOM_HEADERS: Record<string, string> = {
  Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Match the page-embedded bearer token the React board boots for its own API
 * calls. The board embeds it as `"sessionJWT":"{JWT}"` inside its
 * `configsFromHost` bootstrap object — NOT as a `"token"` / `"accessToken"` /
 * `Bearer` literal. The value is captured verbatim (it is a JWT).
 */
export const PAYCOM_SESSION_JWT_REGEX = /"sessionJWT"\s*:\s*"([^"]+)"/;

/**
 * The search endpoint returns an empty result unless the full `filtersForQuery`
 * object is POSTed alongside `skip`/`take` (an "unfiltered" search still needs
 * the empty-filter shape). These are the default, no-criteria values.
 */
export const PAYCOM_SEARCH_FILTERS: Record<string, unknown> = {
  distanceFrom: 0,
  workEnvironments: [],
  positionTypes: [],
  educationLevels: [],
  categories: [],
  travelTypes: [],
  shiftTypes: [],
  otherFilters: [],
  keywordSearchText: '',
  location: '',
  sortOption: '',
};

/**
 * `remoteType` single-letter codes that denote a remote / non-onsite role:
 * `R` remote, `F` field, `H` hybrid, `T` telework. (`O`/empty = onsite.)
 */
export const PAYCOM_REMOTE_TYPE_CODES = new Set(['R', 'F', 'H', 'T']);

/** Matches a board URL's `clientkey` — either `/portal/{KEY}/` or `?clientkey={KEY}`. */
export const PAYCOM_PORTAL_CLIENTKEY_REGEX = /\/portal\/([A-Za-z0-9]+)/i;
export const PAYCOM_QUERY_CLIENTKEY_REGEX = /[?&]clientkey=([A-Za-z0-9]+)/i;

/** A bare clientkey looks like a 16–64 char hex/alphanumeric token. */
export const PAYCOM_CLIENTKEY_TOKEN_REGEX = /^[A-Za-z0-9]{16,64}$/;

/** Detects remote / work-from-home roles across the title and location text. */
export const PAYCOM_REMOTE_REGEX =
  /\b(remote|work\s*from\s*home|wfh|telecommute|fully\s*remote|home[\s-]?based)\b/i;
