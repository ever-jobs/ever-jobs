/**
 * Constants for the Eddy careers platform.
 *
 * Eddy (eddy.com / eddyhr.com — a US small-business HR suite with an applicant-tracking
 * module) hosts every customer tenant's public, unauthenticated candidate-facing careers
 * board on the shared application host `https://app.eddy.com`, addressed by the tenant's
 * **organization UUID**:
 *
 *   https://app.eddy.com/careers/{organizationUuid}                  (careers board shell)
 *   https://app.eddy.com/careers/{organizationUuid}/{jobOpeningUuid} (per-role detail / apply)
 *
 * The careers board is a single-page application: the open roles are NOT embedded in the
 * landing HTML. The page fetches them from a public, anonymous JSON API keyed by the
 * organization UUID:
 *
 *   GET https://app.eddy.com/api/ats/public/job-opening/organization/{organizationUuid}
 *       → JSON array of open roles, each:
 *           { jobOpeningUuid, title, departmentId, locationId, postedDate }
 *
 *   GET https://app.eddy.com/api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}
 *       → per-role detail enriching the list record with:
 *           { title, employmentType, experience, description (HTML), postedDate,
 *             compensation, departmentId, locationId, workplaceType, publishToCareers }
 *
 * The adapter calls the list endpoint, maps each role from the list record, and (best
 * effort, bounded) fans out to the per-role detail endpoint to enrich the description,
 * employmentType, and workplaceType — rather than depending on a client-rendered DOM, a
 * headless browser, or an authenticated REST API.
 *
 * The caller addresses a tenant by `companySlug` (the organization UUID) or by
 * `companyUrl` (a careers URL on the `app.eddy.com` host whose first `/careers/{…}` path
 * segment is the organization UUID). An unknown tenant, a tenant with no open roles, or
 * an empty board degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single bad tenant never nukes a batch run.
 *
 * Surface confidence (researched + verified live 2026-06-03, no authentication):
 *  - Confirmed the platform + the careers host `app.eddy.com`, and that the careers SPA
 *    bundle (`/careers/assets/main-*.js`) builds its data calls against
 *    `/api/ats/public/job-opening/organization/{organizationUuid}` (list) and
 *    `/api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}`
 *    (detail).
 *  - Confirmed both public endpoints answer anonymously and strictly require the
 *    **organization UUID** (passing a human-readable vanity slug yields a 400
 *    "Failed to convert 'organizationUuid'"). A real org UUID returned HTTP 200 with a
 *    JSON role array; a real per-role detail returned HTTP 200 with the role body shape
 *    above. Empty orgs return `[]`, exercising the empty-board path. verified=true.
 */

/** Root domain — used to recognise careers hosts / URLs passed via `companyUrl`. */
export const EDDY_ROOT_DOMAIN = 'eddy.com';

/** Careers host — every tenant's public careers board lives under this single host. */
export const EDDY_CAREERS_HOST = 'app.eddy.com';

/** Careers application origin — the public careers board + public JSON API live here. */
export const EDDY_API_ORIGIN = 'https://app.eddy.com';

/** Public path segment that precedes the organization UUID in a careers board URL. */
export const EDDY_CAREERS_PATH = 'careers';

/**
 * Public, anonymous slug→UUID lookup, the same call the careers SPA issues for vanity
 * careers URLs: `{ currentShortName, organizationUuid }` — the
 * `{organizationUuid}` then keys the jobs endpoints. Unknown slugs answer 404.
 */
export const eddyOrganizationIdUrl = (slug: string): string =>
  `${EDDY_API_ORIGIN}/api/ds/organization/${encodeURIComponent(slug)}/id`;

/**
 * Public, anonymous open-roles list endpoint, keyed by the tenant's organization UUID.
 * Returns a JSON array of lightweight role records
 * (`{ jobOpeningUuid, title, departmentId, locationId, postedDate }`).
 */
export const eddyJobsListUrl = (organizationUuid: string): string =>
  `${EDDY_API_ORIGIN}/api/ats/public/job-opening/organization/${encodeURIComponent(
    organizationUuid,
  )}`;

/**
 * Public, anonymous per-role detail endpoint. Enriches a list record with the description
 * (HTML), `employmentType`, `workplaceType`, `compensation`, and `experience`. Requires
 * BOTH the role UUID and the organization UUID.
 */
export const eddyJobDetailUrl = (
  jobOpeningUuid: string,
  organizationUuid: string,
): string =>
  `${EDDY_API_ORIGIN}/api/ats/public/job-opening/${encodeURIComponent(
    jobOpeningUuid,
  )}/organization/${encodeURIComponent(organizationUuid)}`;

/** Builds a tenant's canonical public careers board URL from its organization UUID. */
export const eddyCareersBoardUrl = (organizationUuid: string): string =>
  `${EDDY_API_ORIGIN}/${EDDY_CAREERS_PATH}/${encodeURIComponent(organizationUuid)}`;

/** Builds the canonical public per-role detail / apply URL. */
export const eddyJobPageUrl = (
  organizationUuid: string,
  jobOpeningUuid: string,
): string =>
  `${EDDY_API_ORIGIN}/${EDDY_CAREERS_PATH}/${encodeURIComponent(
    organizationUuid,
  )}/${encodeURIComponent(jobOpeningUuid)}`;

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: when a caller omits
 * `resultsWanted` entirely we ingest up to 100 of the tenant's open roles.
 */
export const EDDY_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on per-role detail fetches per scrape. The list endpoint returns the full
 * open-roles set in a single document (no server-side pagination of the list), so the
 * board itself is one request; this ceiling bounds the best-effort per-role detail
 * fan-out so a large board never explodes into an unbounded request storm.
 */
export const EDDY_MAX_DETAIL_FETCHES = 50;

/**
 * Upper bound (seconds) on the per-request HTTP timeout. An unresponsive Eddy careers
 * host can connect-then-hang, so we cap the shared client's 60s default to keep
 * graceful-degradation well inside callers' budgets; a healthy tenant responds in well
 * under a second. A caller may request a SHORTER timeout — we only bound the upper end.
 */
export const EDDY_DEFAULT_TIMEOUT_SECONDS = 15;

/** Default request headers. The public JSON API expects a browser-like UA + JSON Accept. */
export const EDDY_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Matches a 36-char canonical UUID (8-4-4-4-12). Used to recognise the organization UUID
 * in a `companySlug` / `companyUrl` — and to validate the `organizationUuid` returned by
 * the vanity-slug lookup, which is what the jobs API strictly requires.
 */
export const EDDY_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `workplaceType` token Eddy emits for fully-remote roles. */
export const EDDY_REMOTE_WORKPLACE_TYPE = 'REMOTE';

/**
 * Detects remote / home-working roles from the title or description text, complementing
 * the structured `workplaceType` flag (English variants — Eddy is a US platform).
 */
export const EDDY_REMOTE_REGEX =
  /\b(remote|home[\s-]?office|work\s*from\s*home|wfh|fully\s*remote|telecommute|telework)\b/i;
