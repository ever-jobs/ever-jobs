import { JobType, ScraperInputDto, getJobTypeFromString } from '@ever-jobs/models';
import {
  SOLIDJOBS_CITY_EXONYMS,
  SOLIDJOBS_CONTRACT_FORMS,
  SOLIDJOBS_COUNTRY_LEVEL_LABELS,
  SOLIDJOBS_DIVISION_HINTS,
  SOLIDJOBS_REMOTE_NEEDLES,
} from './solidjobs.constants';
import { SolidJobsOffer } from './solidjobs.types';

/**
 * Client-side filters for Solid.Jobs (Spec 1709). The public offers endpoint
 * ignores every filter parameter, so `searchTerm`, `location`, `isRemote`,
 * `jobType` and `hoursOld` are applied here, to each offer as its page
 * arrives. Every function is pure; the only clock read is an injectable
 * default.
 */

/** How a search term is matched against an offer. */
export type SolidJobsSearchMode = 'tokens' | 'phrase';

export interface SolidJobsFilterOptions {
  /** `tokens` (default) or the Spec 718 whole-phrase matcher. */
  searchMode?: SolidJobsSearchMode;
  /**
   * When false, `location`, `isRemote`, `jobType` and `hoursOld` are ignored
   * (the Spec 718 behaviour). Defaults to true.
   */
  inputFilters?: boolean;
  /** Clock for the `hoursOld` cut-off. Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface SolidJobsFilter {
  /** Offers posted before this instant are dropped; `null` when `hoursOld` is unset. */
  cutoffMs: number | null;
  /** Names of the active filters, for logging. */
  active: string[];
  /** True when the offer passes every active filter. */
  matches(offer: SolidJobsOffer): boolean;
}

export interface SolidJobsLocationNeedle {
  /** Folded place words to look for, or `null` for no place filter. */
  needle: string | null;
  /** The location asked for remote work. */
  remote: boolean;
}

const INTERNSHIP_RE =
  /(?:^|[^\p{L}\p{N}])(?:intern(?:ship)?s?|trainee(?:ship)?s?|staz\p{L}*|praktyk\p{L}*)(?=$|[^\p{L}\p{N}])/u;

const COUNTRY_WORDS: ReadonlySet<string> = new Set(['poland', 'polska', 'pl', 'cala']);

/**
 * Lower-case, strip diacritics and collapse whitespace. `ł`/`Ł` do not
 * decompose under NFKD (`Łódź` would fold to `łodz`), so they are mapped
 * explicitly.
 */
export function foldText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Folded text reduced to letter/digit words separated by single spaces. */
function toWords(value: unknown): string {
  return foldText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `needle`'s words occur as whole, consecutive words of `hay`. */
function containsWords(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `);
}

/** Search tokens: the folded term split on whitespace, `/` and `,`, de-duplicated. */
export function searchTokens(term: string | null | undefined): string[] {
  const tokens = foldText(term)
    .split(/[\s/,]+/)
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

/**
 * True when every token occurs somewhere in the offer's folded title,
 * company, division, category, sub-category, experience level or skill
 * names. The description is not searched: it is noisy and the largest field.
 */
export function matchesSearchTokens(offer: SolidJobsOffer, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    offer.title,
    offer.company,
    offer.division,
    offer.category,
    offer.subCategory,
    offer.experienceLevel,
    ...(Array.isArray(offer.skills) ? offer.skills : []).map((skill) => skill?.name),
  ]
    .map((value) => foldText(value))
    .join('\u0000');
  return tokens.every((token) => haystack.includes(token));
}

/**
 * The Spec 718 matcher, kept behind `SOLIDJOBS_SEARCH_MODE=phrase`: the whole
 * term, lower-cased, as one substring of the title, category, sub-category or
 * a single skill name.
 */
export function matchesSearchPhrase(offer: SolidJobsOffer, searchTerm: string): boolean {
  const term = searchTerm.toLowerCase();
  const haystacks: Array<string | null | undefined> = [
    offer.title,
    offer.category,
    offer.subCategory,
    ...(Array.isArray(offer.skills) ? offer.skills : []).map((skill) => skill?.name),
  ];
  return haystacks.some((value) => (typeof value === 'string' ? value : '').toLowerCase().includes(term));
}

/**
 * Turn a `location` input into a place needle. Country words (`Poland`,
 * `Polska`, `PL`, `cała Polska`) are dropped, so a country-level request
 * applies no place filter; `remote` / `zdalnie` / `praca zdalna` ask for
 * remote offers; a few English/German city names map to the board's Polish
 * spelling (`Warsaw` → `warszawa`).
 */
export function parseLocationNeedle(location: string | null | undefined): SolidJobsLocationNeedle {
  let words = toWords(location);
  if (!words) return { needle: null, remote: false };

  let remote = false;
  for (const phrase of SOLIDJOBS_REMOTE_NEEDLES) {
    if (containsWords(words, phrase)) {
      remote = true;
      words = ` ${words} `.split(` ${phrase} `).join(' ').trim();
    }
  }

  const place = words
    .split(' ')
    .filter((word) => word.length > 0 && !COUNTRY_WORDS.has(word))
    .map((word) => SOLIDJOBS_CITY_EXONYMS[word] ?? word)
    .join(' ');
  return { needle: place || null, remote };
}

/**
 * True when one of the offer's locations contains the needle as whole words,
 * or the needle contains the location (`warszawa mazowieckie` vs `Warszawa`).
 */
export function matchesLocationNeedle(offer: SolidJobsOffer, needle: string): boolean {
  const entries = (Array.isArray(offer.locations) ? offer.locations : [])
    .map((entry) => toWords(entry))
    .filter((entry) => entry.length > 0);
  return entries.some((entry) => containsWords(entry, needle) || containsWords(needle, entry));
}

/** Resolve `contractTime` ("full_time" | "part_time") to job types. */
export function contractTimeJobTypes(contractTime: string | null | undefined): JobType[] | null {
  if (typeof contractTime !== 'string' || !contractTime.trim()) return null;
  const jobType = getJobTypeFromString(contractTime.replace(/_/g, ' '));
  return jobType ? [jobType] : null;
}

/** True when the primary or secondary salary uses a contractor-style form. */
export function hasContractForm(offer: SolidJobsOffer): boolean {
  const forms = new Set([...SOLIDJOBS_CONTRACT_FORMS].map((form) => form.toLowerCase()));
  return [offer.salary, offer.secondarySalary].some(
    (salary) =>
      !!salary &&
      typeof salary.employmentType === 'string' &&
      forms.has(salary.employmentType.trim().toLowerCase()),
  );
}

/**
 * `jobType` filter. Full/part time read `contractTime` (an unknown value is
 * excluded); CONTRACT reads the Polish contract forms; INTERNSHIP reads the
 * experience level or title. Any other type matches nothing on this board.
 */
export function matchesJobType(offer: SolidJobsOffer, jobType: JobType): boolean {
  switch (jobType) {
    case JobType.FULL_TIME:
    case JobType.PART_TIME:
      return (contractTimeJobTypes(offer.contractTime) ?? []).includes(jobType);
    case JobType.CONTRACT:
      return hasContractForm(offer);
    case JobType.INTERNSHIP:
      return INTERNSHIP_RE.test(foldText(offer.experienceLevel)) || INTERNSHIP_RE.test(foldText(offer.title));
    default:
      return false;
  }
}

/** Posting instant in epoch ms (`validFrom`, else `updatedAt`), or `null` when unparseable. */
export function postedMs(offer: SolidJobsOffer): number | null {
  const raw = offer?.validFrom || offer?.updatedAt;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** True when the offer is inside the `hoursOld` window (an undated offer is kept). */
export function isWithinCutoff(offer: SolidJobsOffer, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return true;
  const ms = postedMs(offer);
  return ms === null || ms >= cutoffMs;
}

/** An offer can become a job only with a key, a title and a URL. */
export function isMappable(offer: SolidJobsOffer | null | undefined): boolean {
  return !!offer && typeof offer === 'object' && !!offer.jobOfferKey && !!offer.title && !!offer.url;
}

/**
 * Build the client-side filter for a scrape, or `null` when nothing filters
 * (then every mappable offer counts and pages can be sized to the request).
 * `isRemote: false` (the DTO default) and `country` never filter: the board
 * is Poland-only and the DTO defaults `country` to USA.
 */
export function buildSolidJobsFilter(
  input: Pick<ScraperInputDto, 'searchTerm' | 'location' | 'isRemote' | 'jobType' | 'hoursOld'>,
  options: SolidJobsFilterOptions = {},
): SolidJobsFilter | null {
  const predicates: Array<(offer: SolidJobsOffer) => boolean> = [];
  const active: string[] = [];
  let cutoffMs: number | null = null;

  const term = typeof input.searchTerm === 'string' ? input.searchTerm.trim() : '';
  if (term) {
    if (options.searchMode === 'phrase') {
      predicates.push((offer) => matchesSearchPhrase(offer, term));
      active.push('searchTerm(phrase)');
    } else {
      const tokens = searchTokens(term);
      if (tokens.length > 0) {
        predicates.push((offer) => matchesSearchTokens(offer, tokens));
        active.push('searchTerm');
      }
    }
  }

  if (options.inputFilters !== false) {
    const location = parseLocationNeedle(input.location);
    if (location.needle) {
      const needle = location.needle;
      predicates.push((offer) => matchesLocationNeedle(offer, needle));
      active.push('location');
    }
    if (input.isRemote === true || location.remote) {
      predicates.push((offer) => offer.isRemote === true);
      active.push('isRemote');
    }
    if (input.jobType) {
      const jobType = input.jobType;
      predicates.push((offer) => matchesJobType(offer, jobType));
      active.push('jobType');
    }
    const hoursOld = Number(input.hoursOld);
    if (input.hoursOld != null && Number.isFinite(hoursOld) && hoursOld > 0) {
      const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now();
      cutoffMs = nowMs - hoursOld * 3_600_000;
      const cutoff = cutoffMs;
      predicates.push((offer) => isWithinCutoff(offer, cutoff));
      active.push('hoursOld');
    }
  }

  if (predicates.length === 0) return null;
  return {
    cutoffMs,
    active,
    matches: (offer) => predicates.every((predicate) => predicate(offer)),
  };
}

/** True when `stem` starts a word of the folded term (or starts with punctuation, like `.net`). */
function hasStem(folded: string, stem: string): boolean {
  let from = 0;
  for (;;) {
    const at = folded.indexOf(stem, from);
    if (at < 0) return false;
    if (at === 0 || !/[\p{L}\p{N}]/u.test(stem[0]) || !/[\p{L}\p{N}]/u.test(folded[at - 1])) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Stable reorder: divisions whose hint stems occur in the search term come
 * first, each group keeping its given order. Every division stays in the list.
 */
export function orderDivisionsByHints(
  divisions: readonly string[],
  searchTerm: string | null | undefined,
): string[] {
  const folded = foldText(searchTerm);
  if (!folded) return [...divisions];
  const hinted = divisions.filter((division) =>
    (SOLIDJOBS_DIVISION_HINTS[division] ?? []).some((stem) => hasStem(folded, stem)),
  );
  return [...hinted, ...divisions.filter((division) => !hinted.includes(division))];
}

/** `B2BSales` → `B2B Sales`, `CustomerSuccess` → `Customer Success`. */
export function humaniseCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const text = code
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return text || null;
}

/** True when a folded location label names the whole country or remote work. */
export function isCountryLevelLabel(label: string): boolean {
  return SOLIDJOBS_COUNTRY_LEVEL_LABELS.has(toWords(label));
}
