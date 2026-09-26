/**
 * Board-wide search query building for the Welcome to the Jungle (WTTJ) plugin (Spec 1705
 * work item A). Pure: time is a parameter, nothing is fetched, nothing throws.
 *
 * The index takes `facetFilters` as a list of AND-ed groups, each an OR-ed list of
 * `attribute:value` strings, and `numericFilters` as `attribute>value` strings. Facet
 * matching is case-insensitive (verified live).
 */
import {
  Country,
  countryFromString,
  getIndeedDomain,
  JobType,
  ScraperInputDto,
} from '@ever-jobs/models';
import { ISO_ALPHA2_TO_ALPHA3, parseLocationText, regionNameFromCode } from '@ever-jobs/common';
import {
  WTTJ_BOARD_DEFAULT_RESULTS,
  WTTJ_BOARD_MAX_FACET_VALUE_LENGTH,
  WTTJ_BOARD_MAX_HITS_PER_PAGE,
  WTTJ_BOARD_MAX_QUERY_LENGTH,
  WTTJ_BOARD_WINDOW,
} from './wttj.constants';
import { contractTokensForJobType } from './wttj.mapper';

/** The input fields board mode reads. */
export type WttjBoardInput = Pick<
  ScraperInputDto,
  | 'searchTerm'
  | 'location'
  | 'country'
  | 'isRemote'
  | 'jobType'
  | 'hoursOld'
  | 'distance'
  | 'resultsWanted'
  | 'offset'
>;

/** A board query, ready to be sent page by page. */
export interface WttjBoardQuery {
  /** Free-text query ('' matches everything, newest first). */
  query: string;
  /** AND-ed groups of OR-ed facet filters. */
  facetFilters: string[][];
  /** Numeric filters (the posting-age cut-off). */
  numericFilters: string[];
  /** Criteria the caller gave that board mode cannot express (for the log). */
  ignored: string[];
}

/** Countries a default search leaves unfiltered: `USA` is the DTO default. */
const UNFILTERED_COUNTRIES: ReadonlySet<Country> = new Set([
  Country.USA,
  Country.US_CANADA,
  Country.WORLDWIDE,
]);

/** Control characters (C0, DEL, C1). */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Clean free text for the `query` parameter: drop `"` and control characters, collapse
 * whitespace, trim, and cap the length.
 */
export function sanitiseQueryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WTTJ_BOARD_MAX_QUERY_LENGTH)
    .trim();
}

/**
 * Clean a value for a facet filter. On top of {@link sanitiseQueryText}, a leading `-`
 * (which the index reads as negation) is removed. Returns null when nothing is left.
 */
export function sanitiseFacetValue(value: unknown): string | null {
  const text = sanitiseQueryText(value).replace(/^[-\s]+/, '').trim();
  const capped = text.slice(0, WTTJ_BOARD_MAX_FACET_VALUE_LENGTH).trim();
  return capped.length > 0 ? capped : null;
}

let isoNameIndex: Map<string, string> | null = null;

/** Lower-cased English country name → ISO alpha-2, built once from the ISO table. */
function isoCodeForName(name: string): string | null {
  if (!isoNameIndex) {
    isoNameIndex = new Map();
    for (const code of Object.keys(ISO_ALPHA2_TO_ALPHA3)) {
      const display = regionNameFromCode(code);
      if (display) isoNameIndex.set(display.toLowerCase(), code);
    }
  }
  return isoNameIndex.get(name.toLowerCase()) ?? null;
}

function isIsoAlpha2(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && Object.prototype.hasOwnProperty.call(ISO_ALPHA2_TO_ALPHA3, code);
}

/** The ISO alpha-2 code of a configured country, or null for the unfiltered ones. */
export function countryCodeForCountry(country: Country | null | undefined): string | null {
  if (!country || UNFILTERED_COUNTRIES.has(country)) return null;
  try {
    const code = getIndeedDomain(country).apiCountryCode;
    return isIsoAlpha2(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * The ISO alpha-2 code for a country name or code (`France`, `United Kingdom`, `UK`,
 * `DE`), or null. Configured countries resolve first, then any ISO 3166-1 country name.
 */
export function countryCodeFromName(name: string | null | undefined): string | null {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return null;
  try {
    const country = countryFromString(text);
    if (UNFILTERED_COUNTRIES.has(country) && country !== Country.USA) return null;
    const code = getIndeedDomain(country).apiCountryCode;
    if (isIsoAlpha2(code)) return code;
  } catch {
    // Not a configured country; try the ISO table.
  }
  const upper = text.toUpperCase();
  if (isIsoAlpha2(upper)) return upper;
  return isoCodeForName(text);
}

/**
 * True when the input carries a board-search criterion: a search term, a location, a
 * posting-age limit, `isRemote: true` or a job type. `country` alone is not one, because
 * the DTO always defaults it.
 */
export function hasBoardCriteria(input: Partial<WttjBoardInput>): boolean {
  return (
    sanitiseQueryText(input.searchTerm).length > 0 ||
    (typeof input.location === 'string' && input.location.trim().length > 0) ||
    (typeof input.hoursOld === 'number' && Number.isFinite(input.hoursOld) && input.hoursOld > 0) ||
    input.isRemote === true ||
    !!input.jobType
  );
}

/**
 * Build the board query for `input` (Spec 1705 A2). `nowSec` is the current epoch in
 * seconds, injected so the posting-age cut-off is testable.
 *
 * - `searchTerm` → `query`.
 * - `location` is parsed: a city gives `[offices.city:X, offices.state:X]` (the OR also
 *   catches a region typed as a city), a region alone the same group the other way round;
 *   a country gives `[offices.country_code:XX]`; a remote mention counts as `isRemote`, and
 *   a hybrid one gives `[remote:partial, remote:punctual]`. Only when the parser recognises
 *   nothing at all is the raw text added to the query instead.
 * - `country` gives the country facet when no country came from `location` and it is not
 *   `USA` / `US_CANADA` / `WORLDWIDE` (the DTO defaults to `USA`, so applying it would hide
 *   most of this board from every default search).
 * - `isRemote: true` → `[remote:fulltime]`, so every result is fully remote.
 * - `jobType` → the OR-group of the contract tokens that map to it; a job type no token
 *   maps to is ignored (and reported in `ignored`).
 * - `hoursOld` → `published_at_timestamp>{nowSec - hoursOld * 3600}`.
 * - `distance` is ignored (radius search is a follow-up).
 */
export function buildBoardQuery(input: Partial<WttjBoardInput>, nowSec: number): WttjBoardQuery {
  const facetFilters: string[][] = [];
  const numericFilters: string[] = [];
  const ignored: string[] = [];
  let query = sanitiseQueryText(input.searchTerm);
  let remote = input.isRemote === true;
  let hybrid = false;
  let countryCode: string | null = null;

  const rawLocation = typeof input.location === 'string' ? input.location.trim() : '';
  if (rawLocation) {
    const parsed = parseLocationText(rawLocation);
    const loc = parsed.location;
    const city = sanitiseFacetValue(loc?.city);
    if (city) {
      facetFilters.push([`offices.city:${city}`, `offices.state:${city}`]);
    } else if (loc?.state) {
      // The parser abbreviates US states ('California' -> 'CA'); the index spells regions
      // out, so the caller's own first segment is the better facet value.
      const region = sanitiseFacetValue(rawLocation.split(',')[0]);
      if (region) facetFilters.push([`offices.state:${region}`, `offices.city:${region}`]);
    }
    if (typeof loc?.country === 'string') countryCode = countryCodeFromName(loc.country);
    if (parsed.remoteMentioned) remote = true;
    else if (parsed.workFromHomeType === 'Hybrid') hybrid = true;
    const recognised =
      !!(city || loc?.state || loc?.country) || parsed.remoteMentioned || !!parsed.workFromHomeType;
    if (!recognised) {
      const text = sanitiseQueryText(rawLocation);
      if (/[\p{L}\p{N}]/u.test(text)) query = sanitiseQueryText(query ? `${query} ${text}` : text);
    }
  }

  if (!countryCode) countryCode = countryCodeForCountry(input.country);
  if (countryCode) facetFilters.push([`offices.country_code:${countryCode}`]);

  if (remote) facetFilters.push(['remote:fulltime']);
  else if (hybrid) facetFilters.push(['remote:partial', 'remote:punctual']);

  if (input.jobType) {
    const tokens = contractTokensForJobType(input.jobType as JobType);
    if (tokens.length > 0) {
      facetFilters.push(tokens.map((token) => `contract_type:${token}`));
    } else {
      ignored.push(`jobType=${input.jobType}`);
    }
  }

  const hoursOld = input.hoursOld;
  if (typeof hoursOld === 'number' && Number.isFinite(hoursOld) && hoursOld > 0) {
    const cutoff = Math.floor(nowSec - hoursOld * 3600);
    numericFilters.push(`published_at_timestamp>${cutoff}`);
  }

  return { query, facetFilters, numericFilters, ignored };
}

/** Which slice of the 1,000-hit window a board scrape reads. */
export interface WttjBoardWindow {
  /** Offset into the result list. */
  offset: number;
  /** Results the caller asked for. */
  resultsWanted: number;
  /** Results reachable inside the window: `min(resultsWanted, 1000 - offset)`. */
  want: number;
  /** True when the window cut the request short (`offset + resultsWanted > 1000`). */
  truncated: boolean;
  /** Page size, constant for the whole scrape. */
  hitsPerPage: number;
  /** First page to request. */
  firstPage: number;
  /** Hits to skip on the first page. */
  skip: number;
}

/**
 * The page size for a slice of `want` hits starting at `offset`: the smallest size from
 * `want` up to 100 whose single page holds the whole slice, so a small request is one
 * small page even when `offset` is not a multiple of `want` (offset 130 + 20 wanted reads
 * one 25-hit page instead of two 20-hit pages). Slices over 100 hits use 100.
 */
function pageSizeFor(offset: number, want: number): number {
  const base = Math.max(1, Math.min(want, WTTJ_BOARD_MAX_HITS_PER_PAGE));
  if (want > WTTJ_BOARD_MAX_HITS_PER_PAGE) return base;
  const last = offset + want - 1;
  for (let size = base; size <= WTTJ_BOARD_MAX_HITS_PER_PAGE; size++) {
    if (Math.floor(offset / size) === Math.floor(last / size)) return size;
  }
  return base;
}

/**
 * Plan the pages for a board scrape (Spec 1705 A2/A3), or `null` when `offset` is already
 * past the window.
 *
 * The page size (see {@link pageSizeFor}) stays the same on every page so the `offset`
 * arithmetic holds.
 */
export function planBoardWindow(input: Partial<WttjBoardInput>): WttjBoardWindow | null {
  const rawWanted = input.resultsWanted;
  const resultsWanted =
    typeof rawWanted === 'number' && Number.isFinite(rawWanted) && rawWanted >= 1
      ? Math.floor(rawWanted)
      : WTTJ_BOARD_DEFAULT_RESULTS;
  const rawOffset = input.offset;
  const offset =
    typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : 0;
  if (offset >= WTTJ_BOARD_WINDOW) return null;

  const want = Math.min(resultsWanted, WTTJ_BOARD_WINDOW - offset);
  const hitsPerPage = pageSizeFor(offset, want);
  return {
    offset,
    resultsWanted,
    want,
    truncated: offset + resultsWanted > WTTJ_BOARD_WINDOW,
    hitsPerPage,
    firstPage: Math.floor(offset / hitsPerPage),
    skip: offset % hitsPerPage,
  };
}
