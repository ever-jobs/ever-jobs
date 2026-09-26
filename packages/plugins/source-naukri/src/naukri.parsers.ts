/**
 * Pure Naukri parsers (Spec 1712).
 *
 * Every function here is total: bad input yields `null` (or the documented
 * empty result) and never throws. Time is injected so the date rules can be
 * tested against a fixed clock.
 */
import {
  CompensationDto,
  CompensationInterval,
  Country,
  LocationDto,
  looksLikeChallenge,
} from '@ever-jobs/models';
import { parseLocationList, toDateOnly } from '@ever-jobs/common';
import { NAUKRI_ORIGIN } from './naukri.constants';
import type { NaukriPlaceholder } from './naukri.types';

// --- Block detection -----------------------------------------------------------

const MAX_BLOCK_DETAIL = 300;
/** A string body longer than this is never sniffed as JSON. */
const MAX_JSON_SNIFF = 256 * 1024;
const CAPTCHA_RE = /captcha/i;

/**
 * Parse a string body that is really JSON (served with a non-JSON content
 * type, so axios left it as text). Anything else is returned unchanged.
 */
export function coerceNaukriBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  const text = body.trim();
  if (text.length > MAX_JSON_SNIFF || !(text.startsWith('{') || text.startsWith('['))) return body;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return body;
  }
}

/** The body's own `message`, from a parsed object or a JSON string. */
function bodyMessage(body: unknown): string | null {
  const parsed = coerceNaukriBody(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = (parsed as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    ('isAxiosError' in value || 'response' in value)
  );
}

function blockDetail(status: number | string, message: string): string {
  return `HTTP ${status}: ${message.replace(/\s+/g, ' ').trim()}`.slice(0, MAX_BLOCK_DETAIL);
}

/**
 * Does this thrown error, or this 200 body, mean the board refused us?
 *
 * Matches an HTTP 406 or 403 (the board answers an unwanted client with
 * `406 {"message":"recaptcha required"}`), any body whose `message` mentions a
 * captcha, and a bot-challenge HTML page. Returns a short reason such as
 * `HTTP 406: recaptcha required` (at most 300 characters), or `null`.
 *
 * Any other failure (404, a timeout, a reset) returns `null`, so the caller
 * keeps the shared classifier for it.
 */
export function detectNaukriBlock(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (isErrorLike(value)) {
    const response = (value as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return null;
    const { status, data } = response as { status?: unknown; data?: unknown };
    const code = typeof status === 'number' && Number.isFinite(status) ? status : null;
    const message = bodyMessage(data);
    const challenge = typeof data === 'string' && looksLikeChallenge(data);
    const captcha = message !== null && CAPTCHA_RE.test(message);
    if (code === 406 || code === 403 || captcha || challenge) {
      return blockDetail(
        code ?? 'error',
        message ?? (challenge ? 'bot challenge page' : 'request refused'),
      );
    }
    return null;
  }

  const body = coerceNaukriBody(value);
  if (typeof body === 'string') {
    return looksLikeChallenge(body) ? blockDetail(200, 'bot challenge page') : null;
  }
  const message = bodyMessage(body);
  if (message && CAPTCHA_RE.test(message)) {
    const inner = (body as { statusCode?: unknown }).statusCode;
    const status =
      typeof inner === 'number' && Number.isFinite(inner) && inner !== 200
        ? `200 (body statusCode ${inner})`
        : 200;
    return blockDetail(status, message);
  }
  return null;
}

// --- Salary --------------------------------------------------------------------

/** Longer text is not a salary chip; refusing it bounds the regex work. */
const MAX_SALARY_LABEL = 200;
const NUM = '\\d+(?:\\.\\d+)?';
const UNIT = 'lacs?|lakhs?|lpa|crores?|cr';
/** Labels are whitespace-collapsed first, so a single optional space suffices. */
const RANGE_RE = new RegExp(
  `(${NUM}) ?(${UNIT})?(?![a-z]) ?(?:-|to\\b) ?(${NUM}) ?(${UNIT})?(?![a-z])`,
  'i',
);
const UP_TO_RE = new RegExp(`(?:\\bup ?to|\\bmax(?:imum)?)\\b:? ?(${NUM}) ?(${UNIT})?(?![a-z])`, 'i');
const SINGLE_RE = new RegExp(`(${NUM}) ?(${UNIT})?(?![a-z])`, 'i');
const UNDISCLOSED_RE = /not ?disclosed|unpaid|best in (?:the )?industry|as per/i;
const YEARLY_RE = /\bp\.? ?a\.?(?![a-z])|\bper ?annum\b|\blpa\b|\bannual(?:ly)?\b|\byearly\b|\bper ?year\b/i;
const MONTHLY_RE = /\bp\.? ?m\.?(?![a-z])|\bper ?month\b|\bmonthly\b/i;

/** Rupees per unit; no unit means literal rupees. */
function unitMultiplier(unit: string | undefined): number {
  const u = (unit ?? '').toLowerCase();
  if (!u) return 1;
  if (u.startsWith('cr')) return 1e7;
  return 1e5; // lac(s), lakh(s), lpa
}

/**
 * Parse a Naukri salary chip into INR.
 *
 * - Ranges (`12-16 Lacs P.A.`, `80 Lacs-1.2 Cr P.A.`, `2,50,000-3,50,000 P.A.`):
 *   a bound with no unit inherits the other bound's unit.
 * - `Up to 10 Lacs P.A.` gives a maximum only; `4.5 LPA` gives min = max.
 * - Units: lac(s) / lakh(s) / LPA = 100 000, cr / crore(s) = 10 000 000.
 * - Interval: `P.A.` / per annum / LPA / annual / yearly = yearly;
 *   `P.M.` / per month / monthly = monthly; otherwise a lakh or crore amount
 *   is yearly (Naukri quotes CTC per annum), else unknown (`null`).
 * - `null` for "Not disclosed" and similar, for an empty label, for a bare
 *   unit-less number below 1 000 (`3-5` is ambiguous), and when min > max.
 */
export function parseNaukriSalary(label: string | null | undefined): CompensationDto | null {
  if (typeof label !== 'string') return null;
  const text = label
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[\u2013\u2014]/g, '-');
  if (!text || text.length > MAX_SALARY_LABEL || UNDISCLOSED_RE.test(text)) return null;

  let min: number | null;
  let max: number;
  let unitSeen = false;

  const range = RANGE_RE.exec(text);
  const upTo = range ? null : UP_TO_RE.exec(text);
  const single = range || upTo ? null : SINGLE_RE.exec(text);

  if (range) {
    const minUnit = range[2] ?? range[4];
    const maxUnit = range[4] ?? range[2];
    if (!minUnit && Number(range[1]) < 1000) return null;
    if (!maxUnit && Number(range[3]) < 1000) return null;
    min = Number(range[1]) * unitMultiplier(minUnit);
    max = Number(range[3]) * unitMultiplier(maxUnit);
    unitSeen = Boolean(minUnit) || Boolean(maxUnit);
  } else if (upTo) {
    if (!upTo[2] && Number(upTo[1]) < 1000) return null;
    min = null;
    max = Number(upTo[1]) * unitMultiplier(upTo[2]);
    unitSeen = Boolean(upTo[2]);
  } else if (single) {
    if (!single[2] && Number(single[1]) < 1000) return null;
    max = Number(single[1]) * unitMultiplier(single[2]);
    min = max;
    unitSeen = Boolean(single[2]);
  } else {
    return null;
  }

  if (!Number.isFinite(max) || max <= 0) return null;
  if (min !== null && (!Number.isFinite(min) || min < 0 || min > max)) return null;

  let interval: CompensationInterval | null = null;
  if (YEARLY_RE.test(text)) interval = CompensationInterval.YEARLY;
  else if (MONTHLY_RE.test(text)) interval = CompensationInterval.MONTHLY;
  else if (unitSeen) interval = CompensationInterval.YEARLY;

  return new CompensationDto({
    minAmount: min === null ? null : Math.round(min),
    maxAmount: Math.round(max),
    interval,
    currency: 'INR',
  });
}

// --- Location ------------------------------------------------------------------

/** Result of {@link parseNaukriLocationLabel}. */
export interface NaukriLocationResult {
  location: LocationDto;
  locations: LocationDto[];
  isRemote: boolean;
  workFromHomeType: string | null;
}

type Qualifier = 'Hybrid' | 'Remote' | 'Office';

const MAX_LOCATION_LABEL = 1000;
const MAX_LOCATION_PARTS = 50;
const REMOTE_PHRASE = '(?:temp(?:orary)?\\.? ?)?(?:wfh|work from home)|remote';
const LEADING_QUALIFIER_RE = new RegExp(
  `^(hybrid|${REMOTE_PHRASE}|work from office|wfo) ?[-\\u2013\\u2014:] ?`,
  'i',
);
const QUALIFIER_ONLY_RE = new RegExp(`^(?:(hybrid)|(${REMOTE_PHRASE})|(work from office|wfo))$`, 'i');

function qualifierOf(text: string): Qualifier | null {
  const m = QUALIFIER_ONLY_RE.exec(text.replace(/[.\s]+$/, '').trim());
  if (!m) return null;
  if (m[1]) return 'Hybrid';
  if (m[2]) return 'Remote';
  return 'Office';
}

function hasPlace(l: LocationDto): boolean {
  return Boolean(l.city || l.state);
}

/**
 * Parse a Naukri location chip.
 *
 * A Naukri label is a list of cities (`Bengaluru, Hyderabad, Pune`), never
 * "City, State", so it is split on commas before the shared parser sees it.
 * A work-mode qualifier (`Hybrid - `, `Remote`, `Temp. WFH - `, `Work from
 * office`) may lead the label, stand alone, appear as a list item or in
 * parentheses; parentheticals are otherwise dropped (`Mumbai (All Areas)`).
 *
 * Remote and hybrid come only from this label, never from the description.
 * Temporary work from home counts as `Remote`. Every entry gets
 * `country: INDIA` unless the label names a country itself: one named country
 * is folded onto the cities (`Dubai, United Arab Emirates`).
 */
export function parseNaukriLocationLabel(label: string | null | undefined): NaukriLocationResult {
  const empty: NaukriLocationResult = {
    location: new LocationDto({ country: Country.INDIA }),
    locations: [],
    isRemote: false,
    workFromHomeType: null,
  };
  if (typeof label !== 'string') return empty;
  let text = label.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_LOCATION_LABEL) return empty;

  const qualifiers = new Set<Qualifier>();

  for (let i = 0; i < 3; i++) {
    const lead = LEADING_QUALIFIER_RE.exec(text);
    if (!lead) break;
    const q = qualifierOf(lead[1]);
    if (q) qualifiers.add(q);
    text = text.slice(lead[0].length).trim();
  }

  text = text
    .replace(/\(([^()]*)\)/g, (_match, inner: string) => {
      const q = qualifierOf(inner.replace(/\s+/g, ' ').trim());
      if (q) qualifiers.add(q);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  const cities: string[] = [];
  for (const raw of text.split(',').slice(0, MAX_LOCATION_PARTS)) {
    const part = raw.trim();
    if (!part) continue;
    const q = qualifierOf(part);
    if (q) qualifiers.add(q);
    else cities.push(part);
  }

  const words: string[] = [];
  if (qualifiers.has('Hybrid')) words.push('Hybrid');
  if (qualifiers.has('Remote')) words.push('Remote');
  if (words.length === 0 && cities.length === 0) {
    return {
      ...empty,
      workFromHomeType: qualifiers.has('Office') ? 'Work from office' : null,
    };
  }

  const parsed = parseLocationList([...words, ...cities]);

  const countryOnly = parsed.locations.filter((l) => !hasPlace(l) && l.country);
  const literalCountries = new Set(
    parsed.locations.filter((l) => l.country).map((l) => String(l.country).toLowerCase()),
  );
  const sited = parsed.locations.filter(hasPlace);

  let locations: LocationDto[];
  if (literalCountries.size === 0) {
    locations = parsed.locations.map((l) => new LocationDto({ ...l, country: Country.INDIA }));
  } else if (literalCountries.size === 1 && countryOnly.length > 0 && sited.length > 0) {
    const country = countryOnly[0].country;
    locations = sited.map((l) => new LocationDto({ ...l, country: l.country ?? country }));
  } else {
    locations = parsed.locations.map((l) => new LocationDto({ ...l }));
  }

  const location = parsed.location ? new LocationDto({ ...parsed.location }) : new LocationDto({});
  if (literalCountries.size === 0 && !location.country) location.country = Country.INDIA;

  return {
    location,
    locations,
    isRemote: parsed.remoteMentioned,
    workFromHomeType:
      parsed.workFromHomeType ?? (qualifiers.has('Office') ? 'Work from office' : null),
  };
}

/** The first chip label of a type (`location`, `salary`, `experience`). */
export function placeholderLabel(
  placeholders: NaukriPlaceholder[] | null | undefined,
  type: string,
): string | null {
  if (!Array.isArray(placeholders)) return null;
  for (const p of placeholders) {
    if (p && p.type === type) return typeof p.label === 'string' ? p.label : null;
  }
  return null;
}

// --- Dates ---------------------------------------------------------------------

/** India Standard Time is UTC+05:30 all year (no DST). */
const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_CREATED_MS = Date.UTC(2000, 0, 1);
const MAX_DATE_LABEL = 64;

/** The IST calendar day (`YYYY-MM-DD`) of an instant. */
export function istDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return toDateOnly(new Date(ms + IST_OFFSET_MS));
}

/** A plausible epoch (ms, or seconds when below 1e11), else `null`. */
function createdMs(value: unknown, now: number): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value.trim())) n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n)) return null;
  if (n < 1e11) n *= 1000;
  if (n < MIN_CREATED_MS || n > now + DAY_MS) return null;
  return n;
}

/**
 * The day a job was posted, as an IST `YYYY-MM-DD` (the labels are relative
 * to India time).
 *
 * - A missing, open-ended (`30+ Days Ago`) or unparseable label defers to a
 *   plausible `createdDate` (2000-01-01 ... now + 1 day).
 * - `Today`, `Just Now`, `Few Hours Ago`, `N hours ago` = today;
 *   `Yesterday` = now - 1 day; `N Days Ago` = now - N x 24 h (millisecond
 *   arithmetic, so month boundaries are exact).
 * - An open-ended label with no `createdDate` gives its lower bound (now - N days).
 * - Otherwise `createdDate`, else `null`.
 */
export function parseNaukriPostedDate(
  label: string | null | undefined,
  createdDate: unknown,
  now: number = Date.now(),
): string | null {
  const clock = Number.isFinite(now) ? now : Date.now();
  const created = createdMs(createdDate, clock);
  const lbl =
    typeof label === 'string' && label.length <= MAX_DATE_LABEL
      ? label.replace(/\s+/g, ' ').trim().toLowerCase()
      : '';
  const openEnded = /(\d{1,4}) ?\+/.exec(lbl);

  if (created !== null && (!lbl || openEnded)) return istDay(created);
  if (/\btoday\b|\bjust now\b|\bfew (?:hours?|hrs?|minutes?|mins?)\b|\b\d{1,3} ?(?:hours?|hrs?|minutes?|mins?)\b/.test(lbl)) {
    return istDay(clock);
  }
  if (/\byesterday\b/.test(lbl)) return istDay(clock - DAY_MS);
  const days = /\b(\d{1,4}) ?days? ago\b/.exec(lbl);
  if (days) return istDay(clock - Number(days[1]) * DAY_MS);
  if (openEnded) return istDay(clock - Number(openEnded[1]) * DAY_MS);
  return created !== null ? istDay(created) : null;
}

/**
 * Oldest IST day a job may carry under `hoursOld`: now - hoursOld, rounded up
 * to whole days (the same rounding as the `days` request parameter).
 */
export function naukriPostedCutoffDay(hoursOld: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(hoursOld) || hoursOld <= 0) return null;
  return istDay(now - Math.ceil(hoursOld / 24) * DAY_MS);
}

// --- Small coercions -----------------------------------------------------------

/** Resolve a site-relative or absolute link against the site; http(s) only. */
export function resolveNaukriUrl(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  try {
    const url = new URL(path.trim(), `${NAUKRI_ORIGIN}/`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Comma list to trimmed, non-empty, case-insensitively unique skills; `null` if none. */
export function parseNaukriSkills(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const token of raw.split(',')) {
    const skill = token.replace(/\s+/g, ' ').trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push(skill);
  }
  return skills.length > 0 ? skills : null;
}

/** A finite number from a number or a non-blank numeric string, else `null`. */
export function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** URL slug of a search term: lowercase, runs of other characters become `-`. */
export function naukriSeoKey(searchTerm: string): string {
  const slug = searchTerm
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-jobs`;
}
