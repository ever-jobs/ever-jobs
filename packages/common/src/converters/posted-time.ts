import { DatePostedBasis, DatePostedPrecision, JobPostDto } from '@ever-jobs/models';
import { toDateOnly } from './date-converter';

/**
 * Sub-day posting-time precision (Spec 1696).
 *
 * `datePosted` stays the canonical `YYYY-MM-DD` value (Spec 5024: the source's
 * own calendar day). These helpers add, when the source gives finer-than-day
 * information, an ISO-8601 UTC instant (`datePostedAt`) plus two small
 * metadata fields that tell a consumer how far to trust it:
 *
 * - `datePostedPrecision` — how wide the error bar is (`exact` … `year`);
 * - `datePostedBasis` — where the value came from (`timestamp` from the
 *   source, a calendar `date` from the source, or `relative`: estimated from
 *   an age label anchored to our fetch time).
 *
 * Invariants every helper upholds (and {@link postedTimeFields} enforces at
 * the DTO boundary):
 *
 * - `datePostedAt != null` ⇒ `datePostedPrecision ∈ {exact, minute, hour}`;
 * - `datePostedPrecision != null` ⇒ `datePosted != null`;
 * - when the source gave a calendar date, `datePosted` is that date and is
 *   never re-derived from the instant.
 *
 * Every function is pure and total: time is injected as a parameter (never
 * read inside, except as a default), and bad input only ever downgrades
 * precision — it never throws, and never changes a `datePosted` that
 * `toDateOnly` would have produced correctly.
 */

export interface PostedTime {
  /** `YYYY-MM-DD` (Spec 5024 semantics). */
  datePosted: string | null;
  /** ISO-8601 UTC instant; only ever set with `exact`, `minute` or `hour` precision. */
  datePostedAt: string | null;
  datePostedPrecision: DatePostedPrecision | null;
  datePostedBasis: DatePostedBasis | null;
}

/** The empty result: nothing is known about the posting time. Frozen — spread it to modify. */
export const NO_POSTED_TIME: Readonly<PostedTime> = Object.freeze({
  datePosted: null,
  datePostedAt: null,
  datePostedPrecision: null,
  datePostedBasis: null,
});

export type AgeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface RelativeAge {
  amount: number;
  unit: AgeUnit;
  /** `now` = "just now" / "moments ago" (amount 0, unit `second`). */
  label: 'ago' | 'now' | 'today' | 'yesterday';
}

/** The four `JobPostDto` keys a posting time maps onto. */
export type PostedTimeFields = Pick<
  JobPostDto,
  'datePosted' | 'datePostedAt' | 'datePostedPrecision' | 'datePostedBasis'
>;

export interface PostedTimeFieldsOptions {
  /**
   * `false` emits only `datePosted` — the shape every source produced before
   * Spec 1696. Defaults to the {@link POSTED_TIME_DETAIL_ENV} setting (on).
   */
  detail?: boolean;
}

/**
 * Kill switch for the three Spec 1696 detail keys. `false`, `0`, `off` or `no`
 * makes {@link postedTimeFields} emit `datePosted` alone, so every job keeps
 * its pre-1696 shape; anything else (or unset) keeps the detail keys. Read on
 * every call, so it can be flipped without a rebuild.
 */
export const POSTED_TIME_DETAIL_ENV = 'EVER_JOBS_POSTED_TIME_DETAIL';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNIT_MS: Readonly<Record<AgeUnit, number>> = {
  second: SECOND_MS,
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

const UNIT_PRECISION: Readonly<Record<AgeUnit, DatePostedPrecision>> = {
  second: DatePostedPrecision.MINUTE,
  minute: DatePostedPrecision.MINUTE,
  hour: DatePostedPrecision.HOUR,
  day: DatePostedPrecision.DAY,
  week: DatePostedPrecision.WEEK,
  month: DatePostedPrecision.MONTH,
  year: DatePostedPrecision.YEAR,
};

const INSTANT_PRECISIONS: ReadonlySet<DatePostedPrecision | null> = new Set([
  DatePostedPrecision.EXACT,
  DatePostedPrecision.MINUTE,
  DatePostedPrecision.HOUR,
]);

/** Nothing on a job board predates this; an earlier value is a parsing artefact. */
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
/** The largest instant a `Date` can hold; past it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;
/** Clock skew we tolerate between a source and us before calling a value "future". */
const MAX_FUTURE_SKEW_MS = 36 * HOUR_MS;
/** Epoch values below this are seconds (1e11 s is the year 5138; 1e11 ms is 1973). */
const EPOCH_SECONDS_BELOW = 1e11;
const MAX_AGE_IN_DAYS = 3650;
/** Longer text cannot be an age label; refusing it early bounds the regex work. */
const MAX_LABEL_LENGTH = 80;
/** A label and a source date more than this many UTC days apart disagree. */
const HINT_TOLERANCE_DAYS = 1;

const RELATIVE_AGE_RE =
  /^(?:(?:re)?posted )?(?:(just now|moments ago|today|yesterday)|(\d{1,4}|an?)\+? (seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?) ago)$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;
const EPOCH_STRING_RE = /^\d{9,13}$/;
const AGE_DAYS_STRING_RE = /^\d{1,4}(?:\.\d+)?$/;

function noPostedTime(): PostedTime {
  return { ...NO_POSTED_TIME };
}

/** Milliseconds of 00:00Z on a real calendar day, else `NaN` (no `Date` roll-over). */
function utcDayMs(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? ms
    : Number.NaN;
}

function dateOnlyMs(text: string): number {
  const match = DATE_ONLY_RE.exec(text);
  return match ? utcDayMs(Number(match[1]), Number(match[2]), Number(match[3])) : Number.NaN;
}

function isPlausible(ms: number, nowMs: number): boolean {
  return (
    Number.isFinite(ms) &&
    ms >= MIN_PLAUSIBLE_MS &&
    ms <= MAX_DATE_MS &&
    ms <= nowMs + MAX_FUTURE_SKEW_MS
  );
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function toAgeUnit(token: string): AgeUnit {
  if (token.startsWith('s')) return 'second';
  if (token.startsWith('mi')) return 'minute';
  if (token.startsWith('h')) return 'hour';
  if (token.startsWith('d')) return 'day';
  if (token.startsWith('w')) return 'week';
  if (token.startsWith('mo')) return 'month';
  return 'year';
}

/** `toDateOnly` with no precision claim — the pre-1696 value, unchanged. */
function dateOnlyFallback(value: string | number | Date): PostedTime {
  const datePosted = toDateOnly(value);
  return datePosted === null ? noPostedTime() : { ...NO_POSTED_TIME, datePosted };
}

function exactInstant(datePosted: string | null, atMs: number): PostedTime {
  return {
    datePosted,
    datePostedAt: new Date(atMs).toISOString(),
    datePostedPrecision: DatePostedPrecision.EXACT,
    datePostedBasis: DatePostedBasis.TIMESTAMP,
  };
}

function sourceDate(datePosted: string): PostedTime {
  return {
    datePosted,
    datePostedAt: null,
    datePostedPrecision: DatePostedPrecision.DAY,
    datePostedBasis: DatePostedBasis.DATE,
  };
}

/**
 * Parse an English age label ("26 minutes ago", "an hour ago", "30+ days ago",
 * "Posted 3 days ago", "just now", "today", "yesterday").
 *
 * Whitespace runs (including the newlines a `<time>` element carries) collapse
 * to single spaces and case is ignored. `a`/`an` means 1 and a trailing `+`
 * is dropped. Amounts are capped at four digits. Anything else — localised
 * text, future phrasing ("in 3 hours"), unquantified labels ("Posted
 * recently"), empty or non-string input — returns `null`; it never throws.
 */
export function parseRelativeAge(text: string | null | undefined): RelativeAge | null {
  if (typeof text !== 'string' || text.length > MAX_LABEL_LENGTH * 4) return null;
  const normalised = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalised === '' || normalised.length > MAX_LABEL_LENGTH) return null;
  const match = RELATIVE_AGE_RE.exec(normalised);
  if (!match) return null;
  switch (match[1]) {
    case 'just now':
    case 'moments ago':
      return { amount: 0, unit: 'second', label: 'now' };
    case 'today':
      return { amount: 0, unit: 'day', label: 'today' };
    case 'yesterday':
      return { amount: 1, unit: 'day', label: 'yesterday' };
    default: {
      const amount = match[2] === 'a' || match[2] === 'an' ? 1 : Number(match[2]);
      return { amount, unit: toAgeUnit(match[3]), label: 'ago' };
    }
  }
}

/** Age in milliseconds; a month counts 30 days and a year 365. */
export function relativeAgeToMs(age: RelativeAge): number {
  return age.amount * UNIT_MS[age.unit];
}

/**
 * Whether an instant falls within `toleranceDays` UTC days of a calendar date.
 * The tolerance absorbs the unknown time zone of a source's date around
 * midnight. `false` for anything unparseable.
 */
export function postedAtAgreesWithDate(
  at: string | number | null | undefined,
  date: string | null | undefined,
  toleranceDays: number = HINT_TOLERANCE_DAYS,
): boolean {
  const atMs = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN;
  const dayMs = typeof date === 'string' ? dateOnlyMs(date.trim()) : Number.NaN;
  if (!Number.isFinite(atMs) || !Number.isFinite(dayMs)) return false;
  return Math.abs(Math.floor(atMs / DAY_MS) - dayMs / DAY_MS) <= toleranceDays;
}

/**
 * Posting time from an absolute source value.
 *
 * - Epoch number, or a numeric string of 9–13 digits: below 1e11 is seconds,
 *   otherwise milliseconds → `exact` / `timestamp`.
 * - ISO datetime with `Z` or a `±hh[:mm]` offset → `exact` / `timestamp`;
 *   `datePosted` keeps the source's local day (Spec 5024).
 * - ISO datetime without an offset is ambiguous (the host zone would decide)
 *   → its date as `day` / `date`, no instant.
 * - `YYYY-MM-DD` → `day` / `date`.
 * - A value before 2000-01-01 or more than 36 h after `nowMs`, an impossible
 *   calendar date, a `Date` object (it may have been built from a date) and
 *   any other string: `datePosted` exactly as `toDateOnly` gives it, with no
 *   precision claimed.
 * - Unparseable input → {@link NO_POSTED_TIME}.
 */
export function postedFromTimestamp(value: unknown, nowMs: number = Date.now()): PostedTime {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return noPostedTime();
    const atMs = value < EPOCH_SECONDS_BELOW ? value * SECOND_MS : value;
    return isPlausible(atMs, now) ? exactInstant(utcDate(atMs), atMs) : dateOnlyFallback(value);
  }

  if (value instanceof Date) return dateOnlyFallback(value);
  if (typeof value !== 'string') return noPostedTime();

  const text = value.trim();
  if (text === '') return noPostedTime();

  if (EPOCH_STRING_RE.test(text)) {
    const epoch = Number(text);
    const atMs = epoch < EPOCH_SECONDS_BELOW ? epoch * SECOND_MS : epoch;
    return isPlausible(atMs, now) ? exactInstant(utcDate(atMs), atMs) : dateOnlyFallback(text);
  }

  if (DATE_ONLY_RE.test(text)) {
    return isPlausible(dateOnlyMs(text), now) ? sourceDate(text) : dateOnlyFallback(text);
  }

  const match = ISO_DATETIME_RE.exec(text);
  if (!match) return dateOnlyFallback(text);

  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const dayMs = utcDayMs(Number(year), Number(month), Number(day));
  const h = Number(hour);
  const m = Number(minute);
  const s = second === undefined ? 0 : Number(second);
  if (!Number.isFinite(dayMs) || h > 23 || m > 59 || s > 59) return dateOnlyFallback(text);

  if (zone === undefined) {
    return isPlausible(dayMs, now) ? sourceDate(text.slice(0, 10)) : dateOnlyFallback(text);
  }

  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(3).replace(':', '') || '0');
    if (offsetHours > 23 || offsetMins > 59) return dateOnlyFallback(text);
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const ms = fraction === undefined ? 0 : Number(`${fraction}00`.slice(0, 3));
  const atMs = dayMs + h * HOUR_MS + m * MINUTE_MS + s * SECOND_MS + ms - offsetMinutes * MINUTE_MS;
  return isPlausible(atMs, now) ? exactInstant(toDateOnly(text), atMs) : dateOnlyFallback(text);
}

/**
 * Posting time from an age label, optionally cross-checked against a calendar
 * date the source also gave (`dateHint`, `YYYY-MM-DD`; anything else is ignored).
 *
 * 1. A sub-day label (seconds, minutes, hours, "just now") yields an instant:
 *    `fetchedAtMs − age`, floored to the minute (no false sub-minute
 *    precision), with `minute` or `hour` precision and `relative` basis.
 *    `datePosted` is the hint when there is one. If the instant's UTC day is
 *    more than one day from the hint, the two disagree and the label is dropped.
 * 2. Otherwise a hint wins as `day` / `date`: a day, week or month label is
 *    coarser than the source's own date ("1 week ago" can be 12 days old), so
 *    it never overrides one.
 * 3. A day-or-coarser label with no hint yields `datePosted` only, with the
 *    label's unit as precision. "today" is a date, never an instant — it can
 *    be 23 h old.
 * 4. Anything else, or an estimate before 2000 → {@link NO_POSTED_TIME}.
 */
export function postedFromRelativeLabel(
  label: string | null | undefined,
  fetchedAtMs: number,
  dateHint?: string | null,
): PostedTime {
  const hintText = typeof dateHint === 'string' ? dateHint.trim() : '';
  const hint = Number.isFinite(dateOnlyMs(hintText)) ? hintText : null;
  const age = Number.isFinite(fetchedAtMs) ? parseRelativeAge(label) : null;

  if (age) {
    const estimate = fetchedAtMs - relativeAgeToMs(age);
    if (estimate >= MIN_PLAUSIBLE_MS && estimate <= MAX_DATE_MS) {
      const subDay = age.unit === 'second' || age.unit === 'minute' || age.unit === 'hour';
      if (subDay) {
        const atMs = floorToMinute(estimate);
        if (hint === null || postedAtAgreesWithDate(atMs, hint)) {
          return {
            datePosted: hint ?? utcDate(atMs),
            datePostedAt: new Date(atMs).toISOString(),
            datePostedPrecision: UNIT_PRECISION[age.unit],
            datePostedBasis: DatePostedBasis.RELATIVE,
          };
        }
      } else if (hint === null) {
        return {
          datePosted: utcDate(estimate),
          datePostedAt: null,
          datePostedPrecision: UNIT_PRECISION[age.unit],
          datePostedBasis: DatePostedBasis.RELATIVE,
        };
      }
    }
  }

  return hint === null ? noPostedTime() : sourceDate(hint);
}

/**
 * Posting time from a day-bucket age such as `ageInDays` (a finite number or
 * numeric string in `0..3650`). Day precision at best, `relative` basis, and
 * no invented time of day. The date arithmetic is the historical
 * `toDateOnly(fetchedAt − days × 86 400 000)`. Anything else → {@link NO_POSTED_TIME}.
 */
export function postedFromAgeInDays(days: unknown, fetchedAtMs: number): PostedTime {
  let amount = Number.NaN;
  if (typeof days === 'number') amount = days;
  else if (typeof days === 'string' && AGE_DAYS_STRING_RE.test(days.trim())) amount = Number(days.trim());
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AGE_IN_DAYS || !Number.isFinite(fetchedAtMs)) {
    return noPostedTime();
  }
  const estimate = fetchedAtMs - amount * DAY_MS;
  const datePosted = estimate >= MIN_PLAUSIBLE_MS ? toDateOnly(estimate) : null;
  if (datePosted === null) return noPostedTime();
  return {
    datePosted,
    datePostedAt: null,
    datePostedPrecision: DatePostedPrecision.DAY,
    datePostedBasis: DatePostedBasis.RELATIVE,
  };
}

function postedTimeDetailEnabled(options: PostedTimeFieldsOptions): boolean {
  if (typeof options.detail === 'boolean') return options.detail;
  const raw = process.env[POSTED_TIME_DETAIL_ENV];
  if (raw === undefined) return true;
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/**
 * Spread helper for a `JobPostDto`: always carries `datePosted` (even when
 * `null`), and each of the other three keys only when it is non-null — so a
 * date-only job serialises exactly as it did before Spec 1696 plus, at most,
 * precision and basis. Re-enforces the module invariants: an instant without
 * `exact`/`minute`/`hour` precision (or one that does not parse) is dropped,
 * and every detail key is dropped when `datePosted` is null.
 */
export function postedTimeFields(
  p: PostedTime,
  options: PostedTimeFieldsOptions = {},
): PostedTimeFields {
  const datePosted = p?.datePosted ?? null;
  const fields: PostedTimeFields = { datePosted };
  if (datePosted === null || !postedTimeDetailEnabled(options)) return fields;

  const at = p.datePostedAt ?? null;
  const precision = p.datePostedPrecision ?? null;
  const basis = p.datePostedBasis ?? null;
  if (at !== null && INSTANT_PRECISIONS.has(precision) && Number.isFinite(Date.parse(at))) {
    fields.datePostedAt = at;
  }
  if (precision !== null) fields.datePostedPrecision = precision;
  if (basis !== null) fields.datePostedBasis = basis;
  return fields;
}

/**
 * Newest-first sort key in milliseconds: `datePostedAt`, else `datePosted` at
 * 00:00Z of its day (or a `Date`'s own instant), else `0`. Always a finite
 * number, so a comparator built on it can never return `NaN` for a junk
 * `datePosted`.
 *
 * Contract for any future freshness filter (Spec 1696 §7.3): an hours-based
 * post-filter must treat a row as posted at the *latest* instant its
 * precision allows — the `datePostedAt` instant; the end of the UTC day
 * (capped at now) for `day`; the date plus 7 days for `week`, and so on. A
 * day-bucketed row can then never be dropped by a 24 h filter, and no time of
 * day ever has to be invented. This key (start of day) is for ordering only.
 */
export function postedSortKey(
  job: { datePosted?: Date | string | null; datePostedAt?: string | null } | null | undefined,
): number {
  const atMs = typeof job?.datePostedAt === 'string' ? Date.parse(job.datePostedAt) : Number.NaN;
  if (Number.isFinite(atMs)) return atMs;
  const posted: unknown = job?.datePosted;
  let ms = Number.NaN;
  if (posted instanceof Date) ms = posted.getTime();
  else if (typeof posted === 'string') ms = Date.parse(posted);
  else if (typeof posted === 'number') ms = posted;
  return Number.isFinite(ms) ? ms : 0;
}
