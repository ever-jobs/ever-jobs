/**
 * Constants for the isolved Hire careers platform.
 *
 * isolved Hire (isolvedhire.com) hosts a branded, public career board for each
 * tenant at `https://{tenant}.isolvedhire.com/`.
 *
 * The board is a Vue SPA shell whose `<job-listings>` web component calls a
 * same-origin JSON API to list open roles:
 *
 *   GET /jobs/                          → HTML shell with componentData (domainId)
 *   GET /core/jobs/{domainId}?getParams → { data: { jobs: [...], jobCount: N } }
 *
 * Each role's detail page embeds a JSON-LD `JobPosting` with the full HTML
 * description body:
 *
 *   GET /jobs/{jobId}.html
 *     → <script type="application/ld+json">{ "@type":"JobPosting", ... }</script>
 *
 * The adapter uses the list API for structured fields (department, compensation,
 * workplaceType) and fans out to detail pages for the description body — a hybrid
 * that yields the richest available data set.
 */

/** Hosted careers host suffix — tenant boards live at `{tenant}.isolvedhire.com`. */
export const ISOLVED_CAREER_HOST_SUFFIX = '.isolvedhire.com';

/** Root domain — used to recognise tenant hosts / URLs passed via `companyUrl`. */
export const ISOLVED_ROOT_DOMAIN = 'isolvedhire.com';

/** Builds a tenant's career-board origin from its slug. */
export const isolvedCareerOrigin = (tenant: string): string =>
  `https://${tenant}${ISOLVED_CAREER_HOST_SUFFIX}`;

/** Board landing page path — the Vue SPA shell that carries domainId in componentData. */
export const ISOLVED_BOARD_PATH = '/jobs/';

/** Core jobs API base path — append `{domainId}` to form the full endpoint. */
export const ISOLVED_CORE_JOBS_PATH = '/core/jobs/';

/**
 * Builds the canonical public detail / apply URL for a role from its sub-domain tenant
 * and stable numeric `jobId`: `https://{tenant}.isolvedhire.com/jobs/{jobId}.html`.
 */
export const isolvedJobDetailUrl = (tenant: string, jobId: string): string =>
  `${isolvedCareerOrigin(tenant)}/jobs/${encodeURIComponent(jobId)}.html`;

/**
 * Default internal results cap. When a caller omits `resultsWanted` the adapter
 * ingests up to 100 of the tenant's open roles.
 */
export const ISOLVED_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on detail pages fetched per scrape. Bounds the per-role fan-out so
 * an unexpectedly huge tenant board never runs away.
 */
export const ISOLVED_MAX_DETAIL_FETCHES = 100;

/**
 * Concurrency cap for the per-role detail fan-out. Roles are fetched in bounded
 * batches (via `Promise.allSettled`) so a large board stays inside CI time budgets.
 */
export const ISOLVED_DETAIL_CONCURRENCY = 8;

/**
 * Upper bound (seconds) on the per-request HTTP timeout. An unresponsive board host
 * degrades gracefully inside callers' budgets; a healthy tenant responds well under
 * a second.
 */
export const ISOLVED_DEFAULT_TIMEOUT_SECONDS = 15;

/** Default request headers. The board expects a browser-like UA. */
export const ISOLVED_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Extracts `domainId` from the board HTML's `window.bootstrapVue(…)` componentData.
 * The capture group is the numeric domainId.
 */
export const ISOLVED_DOMAIN_ID_REGEX = /domainId\s*:\s*(\d+)/;

/**
 * Extracts the company display name from the social-widget componentData block.
 * The capture group is the `domainTitle` value (e.g. "Electra").
 */
export const ISOLVED_DOMAIN_TITLE_REGEX = /domainTitle\s*:\s*"([^"]+)"/;

/**
 * Minimal getParams JSON for the core jobs API. `isInternal: 0` filters to
 * external (public) postings only.
 */
export const ISOLVED_GET_PARAMS = JSON.stringify({ isInternal: 0 });

/**
 * Captures the body of a JSON-LD `<script type="application/ld+json">…</script>` block.
 * The capture group is the raw JSON text.
 */
export const ISOLVED_LD_JSON_REGEX =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Detects remote / home-working roles from the title, location, or type text. */
export const ISOLVED_REMOTE_REGEX =
  /\b(remote|virtual|home[\s-]?(?:based|working|office)|work\s*from\s*home|wfh|telecommute|telework|anywhere)\b/i;

/** Detects remote-capable `workplaceType` values from the core jobs API. */
export const ISOLVED_WORKPLACE_REMOTE_REGEX =
  /remote|work.from.home/i;

/**
 * Common ISO 3166-1 alpha-3 → alpha-2 mappings. The core jobs API returns `iso3`
 * (e.g. "USA"); most callers expect 2-letter codes. Unknown codes pass through.
 */
export const ISO3_TO_ISO2: Record<string, string> = {
  USA: 'US',
  CAN: 'CA',
  GBR: 'GB',
  AUS: 'AU',
  DEU: 'DE',
  FRA: 'FR',
  IND: 'IN',
  MEX: 'MX',
  BRA: 'BR',
  JPN: 'JP',
  NLD: 'NL',
  IRL: 'IE',
  SGP: 'SG',
  ISR: 'IL',
  NZL: 'NZ',
  CHE: 'CH',
  SWE: 'SE',
  ESP: 'ES',
  ITA: 'IT',
  KOR: 'KR',
  PHL: 'PH',
  POL: 'PL',
  ARE: 'AE',
};
