/**
 * Constants for the Dover recruiting-automation ATS careers platform.
 *
 * Dover (dover.com) is a modern recruiting-automation ATS whose candidate-facing
 * product is a no-code, hosted/embeddable careers board on `app.dover.com`. Each
 * tenant's board is addressed by one of:
 *
 *   1. Short board slug:        https://app.dover.com/jobs/{slug}
 *   2. Company + careers UUID:  https://app.dover.com/{company}/careers/{uuid}
 *   3. Apply form (name form):  https://app.dover.com/apply/{Company Name}
 *
 * The boards are client-rendered SPAs; the stable public surface is the REST API
 * the SPA calls (unauthenticated). Reading a tenant's roles is a three-step flow:
 *
 *   1. Resolve the board slug to a careers-page client id:
 *        GET /api/v1/careers-page-slug/{slug}   → { id, name, slug }
 *      (or, when the identifier is already a careers-page UUID:
 *        GET /api/v1/careers-page/{id}          → { id, name, slug })
 *   2. List the tenant's open roles:
 *        GET /api/v1/careers-page/{clientId}/jobs
 *          → { count, next, results: [ { id, title, locations, workplace_type,
 *                                        is_published, is_sample } ] }
 *   3. Overlay each role's rich detail:
 *        GET /api/v1/inbound/application-portal-job/{jobId}
 *          → { title, client_name, user_provided_description, locations,
 *              workplace_type, created, compensation: { lower_bound, upper_bound,
 *              currency_code, salary_range_type, employment_type } }
 *
 * NOTE — the previous adapter called `GET /api/v1/careers-page/{slug}` (slug, not
 * client id) which 404s for every tenant, so it returned zero jobs everywhere.
 * Spec 5033 replaces that surface with the real resolve → list → detail flow.
 *
 * An unknown slug (HTTP 404 / 4xx), a missing feed, or a malformed payload
 * degrades to an empty (graceful) result rather than throwing, so a single bad
 * tenant never breaks a batch run.
 */

import { getCompensationInterval, CompensationInterval } from '@ever-jobs/models';

/** Dover application host that serves the hosted/embedded careers boards. */
export const DOVER_HOST = 'https://app.dover.com';

/** Root domain — used to recognise board hosts passed via `companyUrl`. */
export const DOVER_ROOT_DOMAIN = 'dover.com';

/** API origin for the public, unauthenticated careers REST surface. */
export const DOVER_API_ORIGIN = 'https://app.dover.com';

/** Resolve a board slug → careers-page `{ id, name, slug }`. */
export const DOVER_SLUG_API_TEMPLATE =
  'https://app.dover.com/api/v1/careers-page-slug/{slug}';

/** Resolve a careers-page UUID → careers-page `{ id, name, slug }`. */
export const DOVER_CAREERS_PAGE_API_TEMPLATE =
  'https://app.dover.com/api/v1/careers-page/{id}';

/** List a tenant's open roles by careers-page client id. */
export const DOVER_JOBS_API_TEMPLATE =
  'https://app.dover.com/api/v1/careers-page/{id}/jobs';

/**
 * Job groups (departments) by careers-page client id — the feed the board SPA
 * uses for its per-group sections: `[{ id, name, jobs: [{ id, ... }] }]`.
 */
export const DOVER_JOB_GROUPS_API_TEMPLATE =
  'https://app.dover.com/api/v1/job-groups/{id}/job-groups';

/**
 * Per-role detail overlay. `application-portal-job` is preferred over the
 * cross-tenant `job-board/jobs/{id}` surface because the latter 404s for roles
 * not published to Dover's shared board, while this one is reliable per-tenant.
 */
export const DOVER_DETAIL_API_TEMPLATE =
  'https://app.dover.com/api/v1/inbound/application-portal-job/{id}';

/** Per-role apply-form URL — the target each role links to on the board. */
export const DOVER_APPLY_URL_TEMPLATE =
  'https://app.dover.com/apply/{slug}/{jobId}';

/**
 * Short board URL template (`/jobs/{slug}`) — the `jobUrl` every Dover role
 * carried before the per-role apply links. Kept so `DOVER_JOB_URL_STYLE=board`
 * can restore that identity (URL-based dedup / history keyed on it).
 */
export const DOVER_BOARD_URL_TEMPLATE = 'https://app.dover.com/jobs/{slug}';

/**
 * Shape of a role's `jobUrl`:
 *   - `apply` (default) — the per-role apply form `/apply/{slug}/{jobId}`;
 *   - `board` — the tenant board `/jobs/{slug}` (the pre-apply-link shape).
 * `applyUrl` is always the per-role apply form in both styles.
 */
export type DoverJobUrlStyle = 'apply' | 'board';

/** Env var selecting the `jobUrl` style (`apply` | `board`). */
export const DOVER_JOB_URL_STYLE_ENV = 'DOVER_JOB_URL_STYLE';

/** `jobUrl` style used when the env var is unset or unrecognised. */
export const DOVER_DEFAULT_JOB_URL_STYLE: DoverJobUrlStyle = 'apply';

/**
 * Normalise a raw `DOVER_JOB_URL_STYLE` value. Case/whitespace-insensitive;
 * returns null for an unrecognised non-empty value so the caller can warn.
 */
export function parseDoverJobUrlStyle(raw: string | null | undefined): DoverJobUrlStyle | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return DOVER_DEFAULT_JOB_URL_STYLE;
  if (v === 'apply' || v === 'board') return v;
  return null;
}

/** Careers-board URL by client id, when no slug is known. */
export const DOVER_CAREERS_URL_TEMPLATE = 'https://app.dover.com/careers/{id}';

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: the public DTO
 * default is small, but when a caller omits `resultsWanted` entirely we ingest up
 * to 100 of the tenant's open roles.
 */
export const DOVER_DEFAULT_RESULTS = 100;

/** Default request headers. The board host expects a browser-like UA. */
export const DOVER_HEADERS: Record<string, string> = {
  Accept: 'application/json,text/plain,*/*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Recognises a v4 UUID (the careers-page id form of the identifier). */
export const DOVER_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Matches a Dover board path, capturing the tenant token. `/jobs/{slug}`,
 * `/apply/{name}`, and `/{company}/careers/{uuid}` forms are recognised.
 */
export const DOVER_BOARD_PATH_REGEX =
  /^\/(?:jobs\/([^/?#]+)|apply\/([^/?#]+)|([^/?#]+)\/careers(?:\/|$))/i;

/** `workplace_type` value that marks a fully-remote role. */
export const DOVER_REMOTE_WORKPLACE = 'REMOTE';

/** Detects remote / distributed roles across the title and location text. */
export const DOVER_REMOTE_REGEX =
  /\b(remote|distributed|work\s*from\s*home|wfh|telecommute|fully\s*remote|anywhere)\b/i;

/**
 * Map Dover's `salary_range_type` (e.g. `YEARLY`, `HOURLY`) to a
 * `CompensationInterval`. Reuses the shared resolver so the mapping lands once.
 */
export function doverCompensationInterval(
  salaryRangeType: string | null | undefined,
): CompensationInterval | null {
  if (!salaryRangeType) return null;
  return getCompensationInterval(salaryRangeType);
}
