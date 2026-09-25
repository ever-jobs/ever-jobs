import { Country, JobType } from '@ever-jobs/models';
import { ZipErrorBody } from './ziprecruiter.types';

/**
 * Request identity (Spec 1713, sections 4 and 8).
 *
 * The search endpoint is the backend of the ZipRecruiter mobile app. These
 * headers are the ones the plugin already sent before Spec 1713, unchanged: a
 * desktop user-agent next to the app's Basic credential and its
 * `x-zr-zva-override`. Spec 1713 adds no header.
 *
 * Open decision (owner): send our own honest user-agent or keep the app
 * identity. It needs a verification run from a North-American egress (spec
 * sections 8.1 and 8.3), because every request from our EU egress is refused
 * before it reaches the origin (HTTP 403 `forbidden cf-waf`). Record the
 * outcome here.
 *
 * Until the owner decides, nothing here makes the app identity more
 * convincing by default: the session event stays the pre-1713 JSON body on a
 * client without a cookie jar. The app-shaped form-encoded event (which the
 * app accepts, and whose cookies a jar would keep) is opt-in through
 * {@link ZIPRECRUITER_SESSION_EVENT_ENV} = `form`; `off` sends no session event.
 */
export const ZIPRECRUITER_HEADERS: Record<string, string> = {
  Host: 'api.ziprecruiter.com',
  'accept-encoding': 'gzip',
  authorization: 'Basic YTBlMTk4NjItMjhiYi00YmU3LTlhZDAtZGNhZGMwZjBmY2M5Og==',
  'x-zr-zva-override': 'utm_source:CARNIVAL;utm_medium:NLX',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

/**
 * The pre-1713 session event, POSTed as a JSON object. The default session
 * event (see {@link ZIPRECRUITER_SESSION_EVENT_ENV}); the form-encoded body
 * from {@link buildSessionEventBody} is opt-in.
 */
export const SESSION_EVENT_DATA = {
  device_make: 'Apple',
  device_model: 'Macintosh',
  device_os: 'macOS',
  event_type: 'session',
  device_form_factor: 'desktop',
  platform: 'web',
};

export const ZIPRECRUITER_API_BASE = 'https://api.ziprecruiter.com';
export const ZIPRECRUITER_SEARCH_URL = `${ZIPRECRUITER_API_BASE}/jobs-app/jobs`;
export const ZIPRECRUITER_EVENT_URL = `${ZIPRECRUITER_API_BASE}/jobs-app/event`;

/**
 * Public job link. The double slash is the form the site itself emits: keep it.
 * The link is only ever emitted, never fetched (robots.txt disallows `/jobs/`
 * for every agent).
 */
export const ZIPRECRUITER_JOB_URL_BASE = 'https://www.ziprecruiter.com/jobs//j?lvk=';

export function zipRecruiterJobUrl(listingKey: string): string {
  return `${ZIPRECRUITER_JOB_URL_BASE}${encodeURIComponent(listingKey)}`;
}

/**
 * Countries the board can serve. It lists US and Canadian jobs only.
 * `WORLDWIDE` is allowed on purpose: North-American results are valid answers
 * to a worldwide query. An unset country is allowed too (the DTO defaults to
 * `USA`).
 */
export const SUPPORTED_COUNTRIES: ReadonlySet<string> = new Set<string>([
  Country.USA,
  Country.CANADA,
  Country.US_CANADA,
  Country.WORLDWIDE,
]);

export function isSupportedCountry(country: Country | string | null | undefined): boolean {
  if (country === null || country === undefined || country === '') return true;
  return SUPPORTED_COUNTRIES.has(String(country).trim().toUpperCase());
}

/**
 * `job_country` code -> country name, applied BEFORE location parsing. A raw
 * `CA` would otherwise parse as California.
 */
export const ZIPRECRUITER_COUNTRY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  US: 'United States',
  CA: 'Canada',
});

/** Currency assumed when a salary carries none. */
export const ZIPRECRUITER_DEFAULT_CURRENCY: Readonly<Record<string, string>> = Object.freeze({
  US: 'USD',
  CA: 'CAD',
});

/**
 * `jobType` -> `employment_type` filter value. These are the values the plugin
 * sent before Spec 1713. `full_time` and `part_time` are known to work; the
 * others are unverified (spec section 8.4). An unmapped type sends no filter.
 */
export const EMPLOYMENT_TYPE_PARAM: Readonly<Record<string, string>> = Object.freeze({
  [JobType.FULL_TIME]: 'full_time',
  [JobType.PART_TIME]: 'part_time',
  [JobType.CONTRACT]: 'contractor',
  [JobType.INTERNSHIP]: 'intern',
  [JobType.TEMPORARY]: 'temporary',
});

/** Response `employment_type` values resolved locally before the shared lookup. */
export const EMPLOYMENT_TYPE_LABELS: Readonly<Record<string, JobType>> = Object.freeze({
  intern: JobType.INTERNSHIP,
  per_diem: JobType.PER_DIEM,
  contractor: JobType.CONTRACT,
});

/** How long a geo-block (HTTP 403 `cf-waf`) suppresses further requests from the same egress. */
export const GEO_BLOCK_TTL_MS = 30 * 60 * 1000;

/** Bound on remembered egresses; a caller can name any number of proxy lists. */
export const GEO_BLOCK_MEMO_MAX_ENTRIES = 64;

/** Hard cap on search pages per scrape. */
export const MAX_PAGES = 10;

/** Approximate page size, unverified (spec section 8.2); used only to size the page budget. */
export const PAGE_SIZE_ESTIMATE = 20;

/** Politeness delay between pages, in milliseconds. Requests stay sequential. */
export const PAGE_DELAY_MIN_MS = 5000;
export const PAGE_DELAY_MAX_MS = 10000;

/** Diagnostic detail for a request refused by the geo WAF. States the fact only. */
export const GEO_BLOCK_DETAIL =
  'geo-restricted: the ZipRecruiter app API refuses requests from outside North America ' +
  '(HTTP 403 forbidden cf-waf)';

/** Top-level fields of the form-encoded session event. */
export const SESSION_EVENT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['event_type', 'session'],
  ['logged_in', 'false'],
  ['number_of_retry', '1'],
];

/**
 * Session properties, one `property=<key>:<value>` entry each. They are the
 * values the plugin already sent before Spec 1713 (see
 * {@link SESSION_EVENT_DATA}), re-encoded for the form body, plus the locale.
 * No device or app identity was added.
 */
export const SESSION_EVENT_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['device_make', SESSION_EVENT_DATA.device_make],
  ['device_model', SESSION_EVENT_DATA.device_model],
  ['device_os', SESSION_EVENT_DATA.device_os],
  ['device_form_factor', SESSION_EVENT_DATA.device_form_factor],
  ['platform', SESSION_EVENT_DATA.platform],
  ['locale', 'en_us'],
];

/**
 * Form-encoded session event. `URLSearchParams` keeps the repeated `property`
 * key; a timestamp is generated for each call.
 */
export function buildSessionEventBody(nowMs: number = Date.now()): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of SESSION_EVENT_FIELDS) body.append(key, value);
  for (const [key, value] of SESSION_EVENT_PROPERTIES) body.append('property', `${key}:${value}`);
  body.append('property', `timestamp:${new Date(nowMs).toISOString()}`);
  return body;
}

/**
 * True when an error is the geo WAF refusing our egress: HTTP 403 with an
 * `error_code` containing `cf-waf`. A plain 403 (anti-bot, auth) is not.
 */
export function isGeoBlockError(err: unknown): boolean {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (!response || response.status !== 403) return false;

  let body: unknown = response.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return /cf-waf/i.test(body as string);
    }
  }
  const code = (body as ZipErrorBody | null)?.error_code;
  return typeof code === 'string' && /cf-waf/i.test(code);
}

// -- Options (env) ----------------------------------------------------------
// Each switch keeps the pre-1713 behaviour reachable. Read on every scrape.

/**
 * `false` / `0` / `off` / `no` searches every country, as before Spec 1713.
 * Unset or anything else: non-North-American countries return `bad_input`
 * without a request.
 */
export const ZIPRECRUITER_REGION_GUARD_ENV = 'ZIPRECRUITER_REGION_GUARD';

/**
 * Geo-block memo lifetime in milliseconds. Unset: {@link GEO_BLOCK_TTL_MS}.
 * `0` turns the memo off (every scrape tries again, as before Spec 1713).
 */
export const ZIPRECRUITER_GEO_BLOCK_TTL_ENV = 'ZIPRECRUITER_GEO_BLOCK_TTL_MS';

/**
 * Absolute cap on search pages per scrape. Unset: the smaller of
 * {@link MAX_PAGES} and the page budget `resultsWanted` + `offset` needs.
 */
export const ZIPRECRUITER_MAX_PAGES_ENV = 'ZIPRECRUITER_MAX_PAGES';

/**
 * `true` / `1` / `on` / `yes` restores the pre-1713 request contract: the JSON
 * session event and the retired query names (`radius_miles`, `days_ago`,
 * `form`, `continue_token`), without `remote` / `zipapply`.
 */
export const ZIPRECRUITER_LEGACY_PARAMS_ENV = 'ZIPRECRUITER_LEGACY_PARAMS';

/**
 * `false` / `0` / `off` / `no` returns jobs older than `hoursOld` as well (the
 * server filters by whole days only), as before Spec 1713.
 */
export const ZIPRECRUITER_HOURS_FILTER_ENV = 'ZIPRECRUITER_HOURS_FILTER';

/**
 * Which session event to send before searching:
 * - unset / `json` (default) — the pre-1713 JSON event, on a client without a
 *   cookie jar, exactly as before Spec 1713;
 * - `form` — the app-shaped form-encoded event ({@link buildSessionEventBody})
 *   on a cookie-enabled client. Opt-in: it makes the app identity more
 *   convincing, which is an owner decision (see ZIPRECRUITER_HEADERS);
 * - `off` — no session event at all.
 * {@link ZIPRECRUITER_LEGACY_PARAMS_ENV} implies `json` unless this is `off`.
 */
export const ZIPRECRUITER_SESSION_EVENT_ENV = 'ZIPRECRUITER_SESSION_EVENT';

/** The session event {@link ZIPRECRUITER_SESSION_EVENT_ENV} selects. */
export type ZipRecruiterSessionEvent = 'json' | 'form' | 'off';

export interface ZipRecruiterOptions {
  regionGuard: boolean;
  geoBlockTtlMs: number;
  /** `null` = derive from the page budget, capped at {@link MAX_PAGES}. */
  maxPages: number | null;
  legacyParams: boolean;
  hoursFilter: boolean;
  sessionEvent: ZipRecruiterSessionEvent;
}

type Env = Readonly<Record<string, string | undefined>>;

const FALSY = new Set(['false', '0', 'off', 'no']);
const TRUTHY = new Set(['true', '1', 'on', 'yes']);

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (fallback) return !FALSY.has(raw);
  return TRUTHY.has(raw);
}

function nonNegativeInt(env: Env, name: string): number | null {
  const raw = (env[name] ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function sessionEvent(env: Env, legacyParams: boolean): ZipRecruiterSessionEvent {
  const raw = (env[ZIPRECRUITER_SESSION_EVENT_ENV] ?? '').trim().toLowerCase();
  if (raw === 'off' || FALSY.has(raw) || raw === 'none') return 'off';
  if (raw === 'form' && !legacyParams) return 'form';
  return 'json';
}

export function resolveZipRecruiterOptions(env: Env = process.env): ZipRecruiterOptions {
  const maxPages = nonNegativeInt(env, ZIPRECRUITER_MAX_PAGES_ENV);
  const legacyParams = flag(env, ZIPRECRUITER_LEGACY_PARAMS_ENV, false);
  return {
    regionGuard: flag(env, ZIPRECRUITER_REGION_GUARD_ENV, true),
    geoBlockTtlMs: nonNegativeInt(env, ZIPRECRUITER_GEO_BLOCK_TTL_ENV) ?? GEO_BLOCK_TTL_MS,
    maxPages: maxPages !== null && maxPages >= 1 ? maxPages : null,
    legacyParams,
    hoursFilter: flag(env, ZIPRECRUITER_HOURS_FILTER_ENV, true),
    sessionEvent: sessionEvent(env, legacyParams),
  };
}
