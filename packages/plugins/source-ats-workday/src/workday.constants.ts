/**
 * Workday uses company-specific subdomains. The URL pattern is:
 *   https://{company}.wd{n}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
 *
 * The company slug format for Workday is: {company}:{wd_number}:{site}
 * e.g., "tesla:5:Tesla" or "microsoft:1:External"
 */
import { normalizeUsState, parseLocationList, toDateOnly } from '@ever-jobs/common';

/** Default page size for Workday pagination */
export const WORKDAY_PAGE_SIZE = 20;

/**
 * Maximum number of public CXS detail requests in flight at once, per board.
 *
 * One (Spec 1736 T8 / Spec 1735 §4.6): ~55 company plugins delegate to this
 * adapter in the default fan-out, and their tenants share a handful of Workday
 * clusters (wd1/wd5/wd12), so five per board meant ~280 concurrent requests to
 * `*.myworkdayjobs.com` per search from one egress IP.
 */
export const WORKDAY_DETAIL_CONCURRENCY = 1;

/** Pause before each detail request, milliseconds (random in [min, max]). */
export const WORKDAY_DETAIL_DELAY_MIN_MS = 250;
export const WORKDAY_DETAIL_DELAY_MAX_MS = 500;

/**
 * Env var capping detail requests per scrape (Spec 1736 T11).
 *
 * Detail enrichment is sequential and paced (one request in flight, 250–500 ms
 * apart), so it costs roughly 0.5–1 s per posting: one board at
 * `resultsWanted = 1000` would spend ~10 minutes enriching, long past the
 * fan-out deadline. Only the first N postings that have a detail path are
 * enriched; the rest are returned at list level (title, URL, location, posted
 * date, requisition id — no description or compensation; Spec 1736 §8.1).
 *
 * Unset, blank or not a non-negative integer → {@link DEFAULT_WORKDAY_MAX_DETAIL_FETCHES}.
 * `0` = no detail requests at all. There is no "unlimited" value: set a number
 * at least as large as `resultsWanted` to enrich every posting.
 */
export const WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR = 'WORKDAY_MAX_DETAIL_FETCHES';
export const DEFAULT_WORKDAY_MAX_DETAIL_FETCHES = 50;

/**
 * Env var: wall-clock budget for one Workday scrape, milliseconds (Spec 1736 T11).
 *
 * Measured from the start of `scrape()` and covering both phases. Once spent,
 * no further listing page and no further detail request is started (the one in
 * flight finishes; at most one pause and one request past the budget). Postings
 * already listed are returned; the ones not yet enriched at list level. The
 * first listing page is always requested.
 *
 * The plugin contract carries no fan-out deadline (Spec 5026 T11), so this is
 * the adapter's own bound: without it a board abandoned by the fan-out deadline
 * (`EVER_JOBS_SEARCH_DEADLINE_MS`, 120 s) keeps paging and enriching, detached,
 * until it has everything. Keep it below the fan-out deadline.
 *
 * Unset, blank or not an integer → {@link DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS};
 * `0` or negative disables the budget (the same convention as
 * `EVER_JOBS_SEARCH_DEADLINE_MS`).
 */
export const WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR = 'WORKDAY_SCRAPE_TIME_BUDGET_MS';
export const DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS = 90_000;

const INTEGER_RE = /^[+-]?\d+$/;

/** Read {@link WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR}: a non-negative integer. */
export function readWorkdayMaxDetailFetches(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR]?.trim();
  if (!raw || !INTEGER_RE.test(raw)) return DEFAULT_WORKDAY_MAX_DETAIL_FETCHES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_WORKDAY_MAX_DETAIL_FETCHES;
}

/**
 * Read {@link WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}. Returns the budget in
 * milliseconds; `0` means no budget (a `0` or negative setting).
 */
export function readWorkdayScrapeTimeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]?.trim();
  if (!raw || !INTEGER_RE.test(raw)) return DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS;
  return value > 0 ? value : 0;
}

/**
 * The `searchText` sent to Workday's job search (Spec 1736 T6): the trimmed
 * search term, or `''` in list mode (term absent, null, empty or whitespace —
 * contract C1). Workday filters server-side, so a keyword search only pages
 * and enriches matching postings. A non-string never becomes `"undefined"` /
 * `"null"` / `"[object Object]"` text.
 */
export function workdaySearchText(searchTerm: string | null | undefined): string {
  return typeof searchTerm === 'string' ? searchTerm.trim() : '';
}

/** Default headers for Workday API requests */
export const WORKDAY_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/**
 * Parse a Workday compound slug into its components.
 * Format: "{company}:{wd_number}:{site}"
 * Defaults: wd_number=5, site=External
 */
export function parseWorkdaySlug(slug: string): {
  company: string;
  wdNumber: string;
  site: string;
} {
  const parts = slug.split(':');
  return {
    company: parts[0],
    wdNumber: parts[1] ?? '5',
    site: parts[2] ?? 'External',
  };
}

/**
 * Build the Workday API URL for a given company.
 */
export function buildWorkdayUrl(company: string, wdNumber: string, site: string): string {
  return `https://${company}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${company}/${site}/jobs`;
}

/** Build the public CXS detail endpoint for a search result's external path. */
export function buildWorkdayDetailUrl(
  company: string,
  wdNumber: string,
  site: string,
  externalPath: string,
): string {
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  return `https://${company}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${company}/${site}${path}`;
}

/**
 * Identity of a search-result posting, for de-duplication. `externalPath` is the
 * detail-URL path and is unique per requisition; a listing without one falls back to
 * its title so it is de-duplicated rather than dropped.
 */
export function workdayListingKey(listing: {
  externalPath?: string | null;
  title?: string | null;
}): string | null {
  return listing.externalPath?.trim() || listing.title?.trim() || null;
}

/** A single token containing a digit: the shape of a Workday requisition id. */
const REQUISITION_TOKEN_RE = /^[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$/;

/**
 * Requisition id of a search-result row, for postings returned without a detail
 * response (Spec 1736 T11: past the detail cap or the time budget, or a failed
 * detail request).
 *
 * The detail response's `jobReqId` is what an enriched posting's id is built
 * from; this recovers the same value from the list row so a posting keeps one
 * id whether or not it was enriched. `bulletFields` mixes the id with
 * tenant-specific badges ("Spotlight Job", "Exempt", a location, "Posting End
 * Date: 09/30/2026"), so the id is the first bullet that is a single token
 * containing a digit; failing that, the detail path's trailing `_<id>` suffix
 * when it contains a digit (`…/Software-Engineer_JR0271234` → `JR0271234`).
 * The same rule the Spec 1735 verifier recorded fixtures with.
 */
export function workdayListingRequisitionId(listing: {
  bulletFields?: ReadonlyArray<unknown> | null;
  externalPath?: string | null;
}): string | null {
  for (const bullet of listing.bulletFields ?? []) {
    if (typeof bullet !== 'string') continue;
    const token = bullet.trim();
    if (REQUISITION_TOKEN_RE.test(token)) return token;
  }
  const lastSegment = (listing.externalPath ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
  const underscore = lastSegment.lastIndexOf('_');
  if (underscore < 0) return null;
  const tail = lastSegment.slice(underscore + 1);
  return REQUISITION_TOKEN_RE.test(tail) ? tail : null;
}

/**
 * A Workday location label as the shared parser should see it: Workday
 * sometimes slugifies labels with underscores ("Remote_USA"), which defeats the
 * parser's `\bremote\b` boundary, so "_" becomes a space (Spec 5025).
 */
export function normalizeWorkdayLocationLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  return label.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

/**
 * UK nations the shared parser does not read as countries: in
 * "Oxford - England" it keeps "England" as a site name.
 */
const UK_NATIONS: ReadonlySet<string> = new Set(['england', 'scotland', 'wales', 'northern ireland']);

/**
 * True when a label looks like a place (Spec 1736 T12), judged by the shared
 * location parser: it mentions remote work, or yields a state or a country
 * ("Norwood, Massachusetts", "Warsaw - Poland", "Hong Kong", "Remote - US").
 * A part the parser leaves as a site name also counts when it is a US state
 * ("Austin - TX", Q-096) or a UK nation ("Oxford - England").
 *
 * A bare word or phrase has no location shape — "Drug Manufacturing",
 * "Technical Development", "Spotlight Job", "2 Locations" — and neither does a
 * bare city ("Norwood", "Bengaluru"): the parser has no gazetteer, so a city
 * alone cannot be told from a department.
 */
export function hasWorkdayLocationShape(label: string | null | undefined): boolean {
  const text = normalizeWorkdayLocationLabel(label);
  if (!text) return false;
  const parsed = parseLocationList([text]);
  if (parsed.remoteMentioned) return true;
  if (parsed.location?.state || parsed.location?.country) return true;
  return text
    .split(/\s+[-–]\s+|\s*,\s*/)
    .some((part) => UK_NATIONS.has(part.toLowerCase()) || normalizeUsState(part) !== null);
}

/**
 * Split a detail response's `additionalLocations` into places and the rest
 * (Spec 1736 T12). Some tenants put a department there — Moderna's detail for
 * "Sr. Specialist, Maintenance" lists `["Drug Manufacturing"]` next to the
 * primary "Norwood, Massachusetts" — which the parser would turn into a second
 * site, "Norwood, Massachusetts; Drug Manufacturing".
 *
 * An entry is kept when it has a location shape ({@link hasWorkdayLocationShape}).
 * When the primary location itself has none (a tenant that names sites by a
 * bare city, "Bengaluru" + "Hyderabad"), shapeless entries are kept too: there
 * is nothing to tell them from, and dropping a real site would be worse.
 */
export function splitWorkdayAdditionalLocations(
  primary: string | null | undefined,
  additional: ReadonlyArray<unknown> | null | undefined,
): { locations: string[]; rejected: string[] } {
  const primaryText = normalizeWorkdayLocationLabel(primary);
  const bareSiteTenant = primaryText !== null && !hasWorkdayLocationShape(primaryText);
  const locations: string[] = [];
  const rejected: string[] = [];
  for (const entry of additional ?? []) {
    const text = normalizeWorkdayLocationLabel(typeof entry === 'string' ? entry : null);
    if (!text) continue;
    if (bareSiteTenant || hasWorkdayLocationShape(text)) locations.push(text);
    else rejected.push(text);
  }
  return { locations, rejected };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format a Date as an ISO calendar date (YYYY-MM-DD, UTC).
 * Returns null for an Invalid Date (e.g. a day offset that left the
 * representable ECMAScript date range) instead of letting
 * `.toISOString()` throw a RangeError.
 */
function toIsoDate(date: Date): string | null {
  return toDateOnly(date);
}

/**
 * ISO-shaped absolute date: `YYYY-MM-DD`, optionally followed by a time
 * part (`T`/space separator, optional seconds, fraction and zone). Only
 * this shape is accepted by the absolute-date fallback — `Date.parse`
 * of non-ISO strings (e.g. "May 20, 2026") uses host-LOCAL time, which
 * would make the result drift with the host timezone (NFR-1 / NFR-3).
 */
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Validate that an ISO-shaped Y/M/D triple is a real calendar date
 * (rejects e.g. 2026-02-30, which V8's legacy parser would otherwise
 * roll over into March in local time). TZ-independent.
 */
function isRealUtcDate(year: number, month: number, day: number): boolean {
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/**
 * Parse Workday's `postedOn` field into an ISO calendar date (YYYY-MM-DD).
 *
 * The job-list endpoint returns relative human-readable labels rather than
 * dates — live probe of the public API on 2026-06-11 confirmed the shapes
 * "Posted Today", "Posted Yesterday", "Posted 3 Days Ago" and
 * "Posted 30+ Days Ago". Matching is case-insensitive and tolerant of
 * irregular whitespace. Day arithmetic is UTC-based off `now` (defaults to
 * the current time) so results do not drift with the host timezone.
 *
 * - "Posted Today"        -> ISO date of `now`
 * - "Posted Yesterday"    -> `now` minus 1 day
 * - "Posted N Days Ago"   -> `now` minus N days (null if the offset leaves
 *                            the representable ECMAScript date range)
 * - "Posted N+ Days Ago"  -> null (open lower bound — a concrete date would
 *                            fabricate precision the source never provided)
 * - other strings         -> ISO-shaped absolute date (`YYYY-MM-DD`, optional
 *                            time part) -> that calendar date as written;
 *                            anything else -> null (non-ISO formats are
 *                            host-TZ-dependent under `Date.parse`)
 * - null/undefined/empty  -> null
 *
 * Never throws.
 */
export function parseWorkdayPostedOn(
  postedOn?: string | null,
  now: Date = new Date(),
): string | null {
  if (!postedOn) return null;

  const normalized = postedOn.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;

  if (normalized === 'posted today') {
    return toIsoDate(now);
  }

  if (normalized === 'posted yesterday') {
    return toIsoDate(new Date(now.getTime() - MS_PER_DAY));
  }

  const relativeMatch = normalized.match(/^posted (\d+)(\+)? days? ago$/);
  if (relativeMatch) {
    // "N+ Days Ago" is a lower bound only — no exact date can be derived.
    if (relativeMatch[2]) return null;
    const days = parseInt(relativeMatch[1], 10);
    return toIsoDate(new Date(now.getTime() - days * MS_PER_DAY));
  }

  const isoMatch = postedOn.trim().match(ISO_DATE_RE);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    if (isRealUtcDate(Number(year), Number(month), Number(day))) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * Env var controlling the ATS country overlay (Spec 1689).
 *
 * Workday carries the requisition's ISO-2 country in
 * `jobRequisitionLocation.country.alpha2Code`. Spec 5118 moved it to
 * `JobPostDto.countryCode` only, which dropped it from `location.country` —
 * and so from canonical records, canonical keys and every consumer that reads
 * the parsed location. The overlay restores the pre-5118 behaviour: when the
 * parser found no country, `location.country` is filled from the code (as its
 * CLDR display name, e.g. "US" -> "United States"). A parsed country is never
 * overwritten, and `countryCode` is emitted either way.
 *
 * Default ON. Set to `false` / `0` / `no` / `off` to get the Spec 5118
 * behaviour (code in `countryCode` only). Same variable as the Lever plugin.
 */
export const ATS_COUNTRY_OVERLAY_ENV_VAR = 'EVER_JOBS_ATS_COUNTRY_OVERLAY';

const OVERLAY_OFF_VALUES = new Set(['false', '0', 'no', 'off']);

/** Read {@link ATS_COUNTRY_OVERLAY_ENV_VAR}; unset or unrecognised means ON. */
export function readAtsCountryOverlay(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ATS_COUNTRY_OVERLAY_ENV_VAR]?.trim().toLowerCase();
  if (!raw) return true;
  return !OVERLAY_OFF_VALUES.has(raw);
}
