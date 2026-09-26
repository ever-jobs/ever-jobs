import {
  CompensationDto, CompensationInterval, LocationDto, JobType, getJobTypeFromString,
  COUNTRY_CONFIG, Country, looksLikeChallenge,
} from '@ever-jobs/models';
import { parseLocationText } from '@ever-jobs/common';
import {
  GLASSDOOR_API_HEADERS,
  GLASSDOOR_CLIENT_HINT_HEADERS,
  GLASSDOOR_DOCUMENT_HEADERS,
  GRAPH_ERROR_DETAIL_MAX,
  REMOTE_PSEUDO_LOCATION_ID,
} from './glassdoor.constants';

/**
 * Parse compensation from Glassdoor payPeriodAdjustedPay data.
 *
 * `fallbackCurrency` is used when the listing carries no `payCurrency`. It
 * defaults to `USD`, the value every caller got before Spec 1703; the service
 * now passes the currency of the country domain it searched.
 */
export function parseCompensation(header: any, fallbackCurrency: string = 'USD'): CompensationDto | null {
  const pay = header.payPeriodAdjustedPay;
  if (!pay || (!pay.p10 && !pay.p50 && !pay.p90)) return null;

  const payPeriod = (header.payPeriod ?? '').toUpperCase();
  let interval = CompensationInterval.YEARLY;
  if (payPeriod === 'HOURLY' || payPeriod === 'HOUR') interval = CompensationInterval.HOURLY;
  else if (payPeriod === 'MONTHLY' || payPeriod === 'MONTH') interval = CompensationInterval.MONTHLY;
  else if (payPeriod === 'WEEKLY' || payPeriod === 'WEEK') interval = CompensationInterval.WEEKLY;

  const payCurrency = typeof header.payCurrency === 'string' ? header.payCurrency.trim() : '';

  return new CompensationDto({
    minAmount: pay.p10 ?? null,
    maxAmount: pay.p90 ?? null,
    currency: payCurrency || fallbackCurrency,
    interval,
  });
}

/**
 * Get the correct cursor for a given page number from pagination data.
 */
export function getCursorForPage(paginationCursors: { cursor: string; pageNumber: number }[], page: number): string | null {
  const entry = paginationCursors.find((c) => c.pageNumber === page);
  return entry?.cursor ?? null;
}

/**
 * Parse location from Glassdoor header data.
 */
export function parseLocation(header: any): LocationDto {
  const locationName = header.locationName ?? '';
  return parseLocationText(locationName).location ?? new LocationDto({});
}

/**
 * Map Glassdoor job type value to JobType enum.
 */
export function getJobTypeEnum(value: string): JobType | null {
  const map: Record<string, JobType> = {
    fulltime: JobType.FULL_TIME,
    parttime: JobType.PART_TIME,
    contract: JobType.CONTRACT,
    internship: JobType.INTERNSHIP,
    temporary: JobType.TEMPORARY,
  };
  return map[value.toLowerCase()] ?? getJobTypeFromString(value);
}

// --- Spec 1703: robots-neutral hardening -----------------------------------

export interface GraphCursor {
  cursor: string;
  pageNumber: number;
}

/** What one search response carried, read defensively. */
export interface GraphBody {
  /** The listings, or `null` when the body had no `data.jobListings` object. */
  listings: any[] | null;
  cursors: GraphCursor[];
  /** `errors[].message` texts, in order. */
  errors: string[];
  /** The body was not a JSON object or array (for example an HTML page). */
  nonJson: boolean;
  /** The body (or its headers) is a bot-challenge page. */
  challenge: boolean;
}

/**
 * Case-insensitive read of one response header from an axios headers object or
 * a plain map. Array values are joined; anything else that is not a string or
 * a number reads as `null`.
 */
export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return null;
  }
  return null;
}

const SECURITY_TITLE_RE = /<title>\s*security\s*\|\s*glassdoor/i;

/**
 * Whether a response is a bot-challenge page rather than the site: the shared
 * challenge heuristic, the site's own "Security | Glassdoor" interstitial
 * title, or a `cf-mitigated: challenge` response header (enough on its own).
 */
export function isChallengePage(html: unknown, headers?: unknown): boolean {
  const mitigated = headerValue(headers, 'cf-mitigated');
  if (mitigated && mitigated.trim().toLowerCase() === 'challenge') return true;
  if (typeof html !== 'string' || !html) return false;
  return SECURITY_TITLE_RE.test(html) || looksLikeChallenge(html);
}

/** `<where> challenge (HTTP <status>[, cf-mitigated: <value>])`. */
export function challengeDetail(where: string, status: unknown, headers?: unknown): string {
  const statusText = typeof status === 'number' ? String(status) : '?';
  const mitigated = headerValue(headers, 'cf-mitigated');
  return `${where} challenge (HTTP ${statusText}${mitigated ? `, cf-mitigated: ${mitigated.trim()}` : ''})`;
}

/** Every `data-cf-beacon='...'` / `data-cf-beacon="..."` attribute. */
const CF_BEACON_ATTR_RE = /data-cf-beacon\s*=\s*(?:'[^']*'|"[^"]*")/gi;
const JSON_TOKEN_RE = /"token"\s*:\s*"([^"\\]{20,512})"/g;
/** `<b64url>:<b64url>[:<b64url>...]`: the character classes exclude `:`, so this is linear. */
const SITE_TOKEN_SHAPE_RE = /^[A-Za-z0-9_\-+/=.]+(?::[A-Za-z0-9_\-+/=.]+)+$/;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const LEGACY_CSRF_RE = /gdCSRF\s*=\s*"([^"]{1,512})"/;
/** Visible ASCII only: the token is sent as a header value. */
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;

/**
 * Extract the site's CSRF token from the homepage HTML, or `null`.
 *
 * A challenge page returns `null` outright. Every Cloudflare analytics beacon
 * attribute is removed before matching, because its `"token"` (32 hex
 * characters) is not a site token and a naive `"token":"..."` match picks it
 * up from every block page. A `"token"` value is accepted only in the site's
 * colon-separated shape; the legacy `gdCSRF = "..."` assignment is the
 * secondary match.
 */
export function extractCsrfToken(html: unknown): string | null {
  if (typeof html !== 'string' || !html) return null;
  if (isChallengePage(html)) return null;

  const stripped = html.replace(CF_BEACON_ATTR_RE, '');
  for (const match of stripped.matchAll(JSON_TOKEN_RE)) {
    const candidate = match[1];
    if (candidate.includes(':') && !HEX32_RE.test(candidate) && SITE_TOKEN_SHAPE_RE.test(candidate)) {
      return candidate;
    }
  }

  const legacy = stripped.match(LEGACY_CSRF_RE);
  if (legacy && HEADER_SAFE_RE.test(legacy[1])) return legacy[1];
  return null;
}

function errorMessageOf(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const message = (entry as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(entry).slice(0, GRAPH_ERROR_DETAIL_MAX);
    } catch {
      return '';
    }
  }
  return '';
}

function isGraphCursor(value: unknown): value is GraphCursor {
  if (!value || typeof value !== 'object') return false;
  const c = value as { cursor?: unknown; pageNumber?: unknown };
  return typeof c.cursor === 'string' && c.cursor.length > 0 && typeof c.pageNumber === 'number';
}

/**
 * Read one search response. Accepts the object form and the batched form (an
 * array; its first element is used).
 *
 * `listings` is non-null whenever `data.jobListings` is present, whatever
 * `errors[]` says: the site returns non-fatal errors (a failing SEO-metadata
 * resolver, say) next to a complete job list. `errors` is always filled, so
 * the caller can report it when `listings` is `null`.
 */
export function readGraphBody(raw: unknown, headers?: unknown): GraphBody {
  if (raw === null || typeof raw !== 'object') {
    return {
      listings: null,
      cursors: [],
      errors: [],
      nonJson: true,
      challenge: isChallengePage(typeof raw === 'string' ? raw : '', headers),
    };
  }

  const body = (Array.isArray(raw) ? raw[0] : raw) as { data?: unknown; errors?: unknown } | undefined;
  const errors = Array.isArray(body?.errors)
    ? body.errors.map(errorMessageOf).filter((m) => m.length > 0)
    : [];

  const data = body?.data;
  const jobListings = data && typeof data === 'object'
    ? (data as { jobListings?: unknown }).jobListings
    : undefined;
  if (!jobListings || typeof jobListings !== 'object') {
    return { listings: null, cursors: [], errors, nonJson: false, challenge: false };
  }

  const jl = jobListings as { jobListings?: unknown; paginationCursors?: unknown };
  return {
    listings: Array.isArray(jl.jobListings) ? jl.jobListings : [],
    cursors: Array.isArray(jl.paginationCursors) ? jl.paginationCursors.filter(isGraphCursor) : [],
    errors,
    nonJson: false,
    challenge: false,
  };
}

/** `graphql: <messages joined by "; ">`, truncated. */
export function graphErrorDetail(errors: readonly string[]): string {
  return `graphql: ${errors.join('; ').slice(0, GRAPH_ERROR_DETAIL_MAX)}`;
}

/**
 * Merge a page's cursors into the ones already known, keyed by page number.
 * The site returns a window of cursors around the current page, so replacing
 * the list outright can forget a page that is still ahead.
 */
export function mergeCursors(known: readonly GraphCursor[], incoming: readonly GraphCursor[]): GraphCursor[] {
  const byPage = new Map<number, GraphCursor>();
  for (const c of known) byPage.set(c.pageNumber, c);
  for (const c of incoming) byPage.set(c.pageNumber, c);
  return [...byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Whether a listing is remote: its location text says so, or it sits on the
 * site's "Remote" pseudo-location. `locationType === 'S'` alone means STATE
 * and is not a remote signal.
 */
export function isRemoteListing(header: any, remoteMentioned: boolean): boolean {
  if (remoteMentioned) return true;
  return header?.locationType === 'S' && Number(header?.locId) === REMOTE_PSEUDO_LOCATION_ID;
}

const LISTING_ID_RE = /^\d{1,20}$/;

function listingIdFromLink(link: unknown): string | null {
  if (typeof link !== 'string' || !link) return null;
  try {
    const url = new URL(link, 'https://www.glassdoor.com/');
    const value = url.searchParams.get('jl') ?? url.searchParams.get('jobListingId');
    return value && LISTING_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The listing id: `job.listingId`, else the `jl` (or `jobListingId`) query
 * parameter of the header's job link. Digits only; anything else is `null`.
 */
export function listingIdOf(jobview: any): string | null {
  const raw = jobview?.job?.listingId;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && LISTING_ID_RE.test(raw.trim())) return raw.trim();
  return listingIdFromLink(jobview?.header?.jobLink) ?? listingIdFromLink(jobview?.header?.seoJobLink);
}

/**
 * Join a site-relative path onto the country base URL. `getGlassdoorUrl()`
 * ends with `/`, so string concatenation with a leading-slash path gives `//`
 * (which the site answers with 400); `new URL()` never does.
 */
export function glassdoorUrl(path: string, baseUrl: string): string {
  return new URL(path, baseUrl).toString();
}

/** Canonical job URL: `job-listing/j?jl=<listingId>`. */
export function canonicalJobUrl(listingId: string, baseUrl: string): string {
  return glassdoorUrl(`job-listing/j?jl=${encodeURIComponent(listingId)}`, baseUrl);
}

/**
 * The header's own link (SEO link first), resolved against the base URL.
 * Used only when a row has no listing id. Anything that does not resolve to
 * http(s) gives the base URL.
 */
export function headerJobUrl(header: any, baseUrl: string): string {
  const link = typeof header?.seoJobLink === 'string' && header.seoJobLink
    ? header.seoJobLink
    : typeof header?.jobLink === 'string'
      ? header.jobLink
      : '';
  if (!link) return baseUrl;
  try {
    const url = new URL(link, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : baseUrl;
  } catch {
    return baseUrl;
  }
}

/** `Overview/W-EI_IE<employer.id>.htm`, or `null` without a numeric employer id. */
export function companyUrlOf(header: any, baseUrl: string): string | null {
  const id = header?.employer?.id;
  let digits: string | null = null;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) digits = String(id);
  else if (typeof id === 'string' && LISTING_ID_RE.test(id.trim())) digits = id.trim();
  return digits ? glassdoorUrl(`Overview/W-EI_IE${digits}.htm`, baseUrl) : null;
}

/** `adOrderSponsorshipLevel` lower-cased, else `sponsored` for a sponsored row, else `null`. */
export function listingTypeOf(header: any): string | null {
  const level = header?.adOrderSponsorshipLevel;
  if (typeof level === 'string' && level.trim()) return level.trim().toLowerCase();
  return header?.sponsored ? 'sponsored' : null;
}

/** The employer rating when it is a positive number, else `null`. */
export function companyRatingOf(header: any): number | null {
  const rating = typeof header?.rating === 'string' ? Number(header.rating) : header?.rating;
  return typeof rating === 'number' && Number.isFinite(rating) && rating > 0 ? rating : null;
}

export type GlassdoorRequestKind = 'document' | 'api';

export interface BuildHeadersOptions {
  /**
   * Send the client hints that describe the default browser UA. The service
   * turns them off when the caller supplied its own `userAgent`. Default true.
   */
  clientHints?: boolean;
}

/**
 * Per-request headers. `document` is the homepage GET (HTML, no JSON
 * content-type, no fetch metadata); `api` is the search POST, with `origin` /
 * `referer` taken from the country domain actually searched.
 *
 * No `user-agent` is set here: the HTTP client already sends the caller's
 * `userAgent`, or its default, and a per-request value would override the
 * caller's.
 */
export function buildHeaders(
  baseUrl: string,
  kind: GlassdoorRequestKind,
  options: BuildHeadersOptions = {},
): Record<string, string> {
  if (kind === 'document') return { ...GLASSDOOR_DOCUMENT_HEADERS };
  const origin = new URL(baseUrl).origin;
  return {
    ...GLASSDOOR_API_HEADERS,
    ...(options.clientHints === false ? {} : GLASSDOOR_CLIENT_HINT_HEADERS),
    origin,
    referer: `${origin}/`,
  };
}

let countryNameIndex: Map<string, Country> | null = null;

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A comparable key for a country value: the `Country` member when one matches, else the normalized text. */
function countryKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  if ((Object.values(Country) as string[]).includes(value)) return value;
  if (!countryNameIndex) {
    countryNameIndex = new Map();
    for (const [country, config] of Object.entries(COUNTRY_CONFIG)) {
      for (const name of config.names.split(',')) countryNameIndex.set(normalizeText(name), country as Country);
    }
  }
  const text = normalizeText(value);
  return countryNameIndex.get(text) ?? text;
}

/**
 * The location a caller asked for, parsed, or `null` when the text yields no
 * city, state or country (then no location filter applies).
 */
export function requestedLocationOf(text: string | null | undefined): LocationDto | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const location = parseLocationText(text).location;
  if (!location) return null;
  return location.city || location.state || location.country ? location : null;
}

/**
 * Whether a row's parsed location matches the requested one. Case-,
 * punctuation- and diacritic-insensitive.
 *
 * - With a requested city: the city must match, and so must the state and the
 *   country whenever both sides carry one.
 * - With a state but no city: the state must match (and the country, when both
 *   carry one).
 * - With only a country: the country must match.
 *
 * A row without a country is taken to be in `domainCountry`, the country whose
 * site was searched.
 */
export function matchesRequestedLocation(
  row: LocationDto | null | undefined,
  requested: LocationDto,
  domainCountry?: Country | null,
): boolean {
  if (!row) return false;
  const wantCity = normalizeText(requested.city);
  const wantState = normalizeText(requested.state);
  const wantCountry = countryKey(requested.country);
  const city = normalizeText(row.city);
  const state = normalizeText(row.state);
  const country = countryKey(row.country) || countryKey(domainCountry ?? '');

  if (wantCountry && country && wantCountry !== country) return false;
  if (wantCity) {
    if (city !== wantCity) return false;
    return !(wantState && state && wantState !== state);
  }
  if (wantState) return state === wantState;
  if (wantCountry) return country === wantCountry;
  return true;
}
