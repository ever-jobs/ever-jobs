import { JobType } from '@ever-jobs/models';
import { canonicalCountryName, normalizeUsState, parseLocationList, parseLocationText } from '@ever-jobs/common';
import {
  SIMPLIFYJOBS_CA_PROVINCES,
  SIMPLIFYJOBS_DAY_SECONDS,
  SIMPLIFYJOBS_DEFAULT_RESULTS,
  SIMPLIFYJOBS_MAX_RESULTS,
  SIMPLIFYJOBS_MAX_SEARCH_TOKENS,
} from './simplifyjobs.constants';
import { hasSummerTerm, normalizeFeedLocation } from './simplifyjobs.mapper';
import { SimplifyFeedKind, SimplifyLocationFacts, SimplifyRow } from './simplifyjobs.types';

/** Which feeds a job type needs; `null` when neither list carries that type. */
export interface SimplifyJobTypeRoute {
  feeds: SimplifyFeedKind[];
  /** `SUMMER`: keep only internships with a summer term. */
  summerOnly: boolean;
}

/**
 * Unset → both lists (new grad first); `INTERNSHIP` → internships; `SUMMER` →
 * internships with a summer term; `FULL_TIME` → new grad. Every other type
 * (part-time, contract, permanent, apprenticeship…) is on neither list: the
 * caller answers it with no request.
 */
export function routeJobType(jobType: unknown): SimplifyJobTypeRoute | null {
  if (jobType === undefined || jobType === null || jobType === '') {
    return { feeds: ['newgrad', 'internships'], summerOnly: false };
  }
  switch (jobType) {
    case JobType.INTERNSHIP:
      return { feeds: ['internships'], summerOnly: false };
    case JobType.SUMMER:
      return { feeds: ['internships'], summerOnly: true };
    case JobType.FULL_TIME:
      return { feeds: ['newgrad'], summerOnly: false };
    default:
      return null;
  }
}

const NON_ASCII_RE = /[^\x00-\x7f]/;
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Lower-case and strip accents (NFKD, combining marks removed). */
export function foldText(value: string): string {
  const lower = value.toLowerCase();
  return NON_ASCII_RE.test(lower) ? lower.normalize('NFKD').replace(COMBINING_MARKS_RE, '') : lower;
}

function isWordChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || code >= 0x80;
}

/**
 * Whether `needle` occurs in `haystack` at the start of a word (both already
 * folded). A needle that itself starts with punctuation (`.net`, `#`) may
 * match anywhere. So `quant` finds "Quantitative", `intern` finds
 * "Internship", and `uk` does not find "Milwaukee".
 */
export function includesAtWordStart(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const anywhere = !isWordChar(needle.charCodeAt(0));
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    if (anywhere || i === 0 || !isWordChar(haystack.charCodeAt(i - 1))) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

const EDGE_PUNCTUATION_RE = /^[,;:!?()[\]{}'"]+|[,;:!?()[\]{}'"]+$/g;

/**
 * Search tokens: folded, a double-quoted phrase is one token, everything
 * else splits on whitespace. Edge punctuation is dropped (`c++` and `c#`
 * survive). At most {@link SIMPLIFYJOBS_MAX_SEARCH_TOKENS} tokens are kept.
 */
export function tokenizeSearchTerm(term: unknown): string[] {
  if (typeof term !== 'string') return [];
  const folded = foldText(term).replace(/\s+/g, ' ').trim();
  if (!folded) return [];
  const tokens: string[] = [];
  const phraseRe = /"([^"]*)"/g;
  let rest = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(folded)) !== null) {
    rest += ` ${folded.slice(last, match.index)} `;
    const phrase = match[1].trim();
    if (phrase) tokens.push(phrase);
    last = match.index + match[0].length;
  }
  rest += ` ${folded.slice(last)}`;
  for (const word of rest.split(' ')) {
    const token = word.replace(EDGE_PUNCTUATION_RE, '');
    if (token) tokens.push(token);
  }
  return tokens.slice(0, SIMPLIFYJOBS_MAX_SEARCH_TOKENS);
}

/** Every token must start a word in title, company, category or terms. */
export function matchesSearch(row: SimplifyRow, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = foldText(`${row.title} ${row.companyName} ${row.category ?? ''} ${row.terms.join(' ')}`);
  return tokens.every((token) => includesAtWordStart(haystack, token));
}

/**
 * `hoursOld` cut-off. A row is kept when posted at or after the cut-off; a
 * midnight-aligned value only knows its day, so it counts as posted at the
 * END of that day (Spec 1696 §7.3) — otherwise `hoursOld: 12` at 20:00 UTC
 * would drop today's rows stamped 00:00. Rows with no date are kept, as
 * sibling boards do.
 */
export function isFreshEnough(row: Pick<SimplifyRow, 'datePosted'>, cutoffSeconds: number): boolean {
  const posted = row.datePosted;
  if (posted === null) return true;
  if (posted >= cutoffSeconds) return true;
  return posted % SIMPLIFYJOBS_DAY_SECONDS === 0 && posted + SIMPLIFYJOBS_DAY_SECONDS > cutoffSeconds;
}

/** Newest first: `date_posted` desc, then `date_updated` desc, then `id` asc; undated rows last. */
export function compareRows(a: SimplifyRow, b: SimplifyRow): number {
  const posted = (b.datePosted ?? -1) - (a.datePosted ?? -1);
  if (posted !== 0) return posted;
  const updated = (b.dateUpdated ?? -1) - (a.dateUpdated ?? -1);
  if (updated !== 0) return updated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Merge lists that are each already sorted by {@link compareRows}. */
export function mergeSorted(lists: ReadonlyArray<readonly SimplifyRow[]>): SimplifyRow[] {
  const nonEmpty = lists.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return [...nonEmpty[0]];
  const out: SimplifyRow[] = [];
  const index = nonEmpty.map(() => 0);
  for (;;) {
    let best = -1;
    for (let k = 0; k < nonEmpty.length; k++) {
      if (index[k] >= nonEmpty[k].length) continue;
      if (best === -1 || compareRows(nonEmpty[k][index[k]], nonEmpty[best][index[best]]) < 0) best = k;
    }
    if (best === -1) return out;
    out.push(nonEmpty[best][index[best]++]);
  }
}

/** Dedup key of an apply URL: trimmed, scheme and host lower-cased, one trailing `/` dropped. */
export function urlKey(url: string): string {
  const trimmed = url.trim();
  const withHost = trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i, (origin) => origin.toLowerCase());
  return withHost.endsWith('/') ? withHost.slice(0, -1) : withHost;
}

/** Keep the first row per apply URL (the input is newest-first, so the newest wins). */
export function dedupByUrl(rows: readonly SimplifyRow[]): SimplifyRow[] {
  const seen = new Set<string>();
  const out: SimplifyRow[] = [];
  for (const row of rows) {
    const key = urlKey(row.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** `offset` / `resultsWanted` as a slice: offset ≥ 0, limit clamped to `[1, MAX]`. */
export function resolvePaging(offset: unknown, resultsWanted: unknown): { offset: number; limit: number } {
  const off = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const wanted =
    typeof resultsWanted === 'number' && Number.isFinite(resultsWanted) ? Math.floor(resultsWanted) : SIMPLIFYJOBS_DEFAULT_RESULTS;
  return { offset: off, limit: Math.min(SIMPLIFYJOBS_MAX_RESULTS, Math.max(1, wanted)) };
}

/** A US state code implies the US, a Canadian province code Canada (for filtering only). */
function inferredCountry(state: string): string | null {
  if (normalizeUsState(state) === state) return 'United States';
  if (Object.prototype.hasOwnProperty.call(SIMPLIFYJOBS_CA_PROVINCES, state)) return 'Canada';
  return null;
}

/** Filtering facts of one raw location label. */
export function locationFactsOf(label: string): SimplifyLocationFacts {
  const normalised = normalizeFeedLocation(label);
  const parsed = parseLocationList([normalised]);
  const parts: string[] = [label, normalised];
  const countries = new Set<string>();
  const states = new Set<string>();
  for (const loc of parsed.locations) {
    if (loc.city) parts.push(loc.city);
    let country = loc.country ? canonicalCountryName(loc.country) ?? loc.country : null;
    if (loc.state) {
      const code = loc.state.trim().toUpperCase();
      states.add(code);
      parts.push(code);
      const province = SIMPLIFYJOBS_CA_PROVINCES[code];
      if (province) parts.push(province);
      country = country ?? inferredCountry(code);
    }
    if (country) {
      countries.add(country);
      parts.push(country);
    }
  }
  return {
    haystack: foldText(parts.join(' | ')),
    countries: [...countries],
    states: [...states],
    remote: parsed.remoteMentioned,
  };
}

/**
 * Parsed facts per distinct label, kept across scrapes. The feeds repeat a
 * few thousand labels over ~8k rows, so this bounds the parsing work of a
 * location filter to the first scrape. Cleared when it reaches its cap.
 */
export class LocationFactsMemo {
  private readonly facts = new Map<string, SimplifyLocationFacts>();

  constructor(private readonly max: number) {}

  get(label: string): SimplifyLocationFacts {
    const hit = this.facts.get(label);
    if (hit) return hit;
    if (this.facts.size >= this.max) this.facts.clear();
    const facts = locationFactsOf(label);
    this.facts.set(label, facts);
    return facts;
  }

  get size(): number {
    return this.facts.size;
  }
}

/** A caller's `location`, prepared once per scrape. */
export interface LocationQuery {
  folded: string;
  city: string | null;
  state: string | null;
  country: string | null;
  remote: boolean;
}

export function buildLocationQuery(location: unknown): LocationQuery | null {
  if (typeof location !== 'string') return null;
  const folded = foldText(location).replace(/\s+/g, ' ').trim();
  if (!folded) return null;
  const parsed = parseLocationText(location);
  const loc = parsed.location;
  const country = loc?.country ? canonicalCountryName(loc.country) ?? loc.country : null;
  return {
    folded,
    city: loc?.city ? foldText(loc.city) : null,
    state: loc?.state ? loc.state.trim().toUpperCase() : null,
    country,
    remote: parsed.remoteMentioned,
  };
}

/**
 * A row matches when ANY of its labels does: the whole query starts a word in
 * the label's facts (raw label, normalised label, parsed city / state /
 * province name / country); otherwise, when the query names a state, a
 * country or remote work, every part it names agrees with that label's
 * parsed facts. So `New York` finds `NYC`, `United Kingdom` finds
 * `London, UK`, `Canada` finds `London, ON`, and `UK` does not find
 * `Milwaukee, WI`.
 */
export function matchesLocation(
  row: Pick<SimplifyRow, 'locations'>,
  query: LocationQuery,
  memo: LocationFactsMemo,
): boolean {
  const structured = query.state !== null || query.country !== null || query.remote;
  for (const label of row.locations) {
    const facts = memo.get(label);
    if (includesAtWordStart(facts.haystack, query.folded)) return true;
    if (!structured) continue;
    if (query.city && !includesAtWordStart(facts.haystack, query.city)) continue;
    if (query.state && !facts.states.includes(query.state)) continue;
    if (query.country && !facts.countries.includes(query.country)) continue;
    if (query.remote && !facts.remote) continue;
    return true;
  }
  return false;
}

/** `isRemote: true`: some label mentions remote work. */
export function isRemoteRow(row: Pick<SimplifyRow, 'locations'>, memo: LocationFactsMemo): boolean {
  return row.locations.some((label) => memo.get(label).remote);
}

export interface SimplifyFilter {
  tokens: readonly string[];
  location: LocationQuery | null;
  remoteOnly: boolean;
  /** Epoch seconds, or null for no `hoursOld`. */
  cutoffSeconds: number | null;
  summerOnly: boolean;
}

/** Row-local filters, cheapest first. */
export function matchesFilter(row: SimplifyRow, filter: SimplifyFilter, memo: LocationFactsMemo): boolean {
  if (filter.summerOnly && !hasSummerTerm(row)) return false;
  if (filter.cutoffSeconds !== null && !isFreshEnough(row, filter.cutoffSeconds)) return false;
  if (!matchesSearch(row, filter.tokens)) return false;
  if (filter.remoteOnly && !isRemoteRow(row, memo)) return false;
  if (filter.location && !matchesLocation(row, filter.location, memo)) return false;
  return true;
}

/**
 * Filter each feed's rows (already newest-first), merge them newest-first,
 * then drop repeated apply URLs, within and across feeds. Touches every row;
 * {@link selectPage} gives the same order lazily.
 */
export function selectRows(
  feeds: ReadonlyArray<readonly SimplifyRow[]>,
  filter: SimplifyFilter,
  memo: LocationFactsMemo,
): SimplifyRow[] {
  const filtered = feeds.map((rows) => rows.filter((row) => matchesFilter(row, filter, memo)));
  return dedupByUrl(mergeSorted(filtered));
}

export interface SelectedPage {
  rows: SimplifyRow[];
  /** Distinct matching rows found (offset + page); a lower bound unless `exhausted`. */
  matched: number;
  /** Every row was examined, so `matched` is the full count. */
  exhausted: boolean;
}

/**
 * `selectRows(...).slice(offset, offset + limit)`, computed lazily: the
 * pre-sorted feeds are merged head by head, each head is filtered once, and
 * the walk stops as soon as `offset + limit` distinct rows are found. A
 * default search (15 rows, no filter) touches ~15 rows instead of ~8k and
 * builds no per-row dedup keys for the rest.
 */
export function selectPage(
  feeds: ReadonlyArray<readonly SimplifyRow[]>,
  filter: SimplifyFilter,
  memo: LocationFactsMemo,
  offset: number,
  limit: number,
): SelectedPage {
  const index = feeds.map(() => 0);
  const seen = new Set<string>();
  const rows: SimplifyRow[] = [];
  const want = offset + limit;
  let matched = 0;

  /** Advance feed k to its next row that passes the filter; that row, or null when the feed is done. */
  const head = (k: number): SimplifyRow | null => {
    const list = feeds[k];
    while (index[k] < list.length) {
      const row = list[index[k]];
      if (matchesFilter(row, filter, memo)) return row;
      index[k]++;
    }
    return null;
  };
  const heads = feeds.map((_, k) => head(k));

  while (matched < want) {
    let best = -1;
    for (let k = 0; k < heads.length; k++) {
      const candidate = heads[k];
      if (candidate && (best === -1 || compareRows(candidate, heads[best] as SimplifyRow) < 0)) best = k;
    }
    if (best === -1) return { rows, matched, exhausted: true };
    const row = heads[best] as SimplifyRow;
    index[best]++;
    heads[best] = head(best);

    const key = urlKey(row.url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (matched >= offset) rows.push(row);
    matched++;
  }
  return { rows, matched, exhausted: heads.every((h) => h === null) };
}
