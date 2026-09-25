import {
  DatePostedBasis,
  DatePostedPrecision,
  JobPostDto,
} from '@ever-jobs/models';
import { toDateOnly } from '../src/converters/date-converter';
import {
  NO_POSTED_TIME,
  POSTED_TIME_DETAIL_ENV,
  PostedTime,
  parseRelativeAge,
  postedAtAgreesWithDate,
  postedFromAgeInDays,
  postedFromRelativeLabel,
  postedFromTimestamp,
  postedSortKey,
  postedTimeFields,
  relativeAgeToMs,
} from '../src/converters/posted-time';
import * as commonBarrel from '../src';

// Every case runs against the default rules, whatever the shell exports; the
// cases that test the switch set it themselves.
const shellDetail = process.env[POSTED_TIME_DETAIL_ENV];
beforeEach(() => {
  delete process.env[POSTED_TIME_DETAIL_ENV];
});
afterAll(() => {
  if (shellDetail === undefined) delete process.env[POSTED_TIME_DETAIL_ENV];
  else process.env[POSTED_TIME_DETAIL_ENV] = shellDetail;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The probe's fetch instant for the search-card tuples (Spec 1696 §2). */
const FETCHED_AT = Date.parse('2026-09-24T20:00:03Z');
/** `now` for the absolute-timestamp cases. */
const NOW = Date.parse('2026-09-24T20:00:00Z');

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SUB_DAY: Array<DatePostedPrecision | null> = [
  DatePostedPrecision.EXACT,
  DatePostedPrecision.MINUTE,
  DatePostedPrecision.HOUR,
];

function expectInvariants(p: PostedTime): void {
  if (p.datePostedAt !== null) {
    expect(p.datePostedAt).toMatch(ISO_UTC);
    expect(SUB_DAY).toContain(p.datePostedPrecision);
    expect(p.datePostedBasis).not.toBeNull();
  }
  if (p.datePostedPrecision !== null) {
    expect(p.datePosted).not.toBeNull();
    expect(p.datePosted).toMatch(DATE_ONLY);
    expect(p.datePostedBasis).not.toBeNull();
  }
}

describe('posted-time — Spec 1696', () => {
  describe('models surface', () => {
    it('exposes the two enums with their wire values', () => {
      expect(Object.values(DatePostedPrecision)).toEqual([
        'exact', 'minute', 'hour', 'day', 'week', 'month', 'year',
      ]);
      expect(Object.values(DatePostedBasis)).toEqual(['timestamp', 'date', 'relative']);
    });

    it('lets JobPostDto carry the three optional fields and leaves them absent by default', () => {
      const bare = new JobPostDto({ title: 't', jobUrl: 'https://example.test/1', datePosted: '2026-09-24' });
      expect(bare.datePostedAt).toBeUndefined();
      expect(bare.datePostedPrecision).toBeUndefined();
      expect(bare.datePostedBasis).toBeUndefined();

      const rich = new JobPostDto({
        title: 't',
        jobUrl: 'https://example.test/2',
        ...postedTimeFields(postedFromTimestamp(1790280000000, NOW)),
      });
      expect(rich.datePosted).toBe('2026-09-24');
      expect(rich.datePostedAt).toBe('2026-09-24T20:00:00.000Z');
      expect(rich.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
      expect(rich.datePostedBasis).toBe(DatePostedBasis.TIMESTAMP);
    });

    it('is exported from the @ever-jobs/common barrel', () => {
      expect(commonBarrel.postedFromTimestamp).toBe(postedFromTimestamp);
      expect(commonBarrel.postedFromRelativeLabel).toBe(postedFromRelativeLabel);
      expect(commonBarrel.postedFromAgeInDays).toBe(postedFromAgeInDays);
      expect(commonBarrel.postedTimeFields).toBe(postedTimeFields);
      expect(commonBarrel.postedSortKey).toBe(postedSortKey);
      expect(commonBarrel.parseRelativeAge).toBe(parseRelativeAge);
      expect(commonBarrel.postedAtAgreesWithDate).toBe(postedAtAgreesWithDate);
      expect(commonBarrel.NO_POSTED_TIME).toBe(NO_POSTED_TIME);
    });
  });

  describe('NO_POSTED_TIME', () => {
    it('is all null and frozen, so no caller can corrupt the shared value', () => {
      expect(NO_POSTED_TIME).toEqual({
        datePosted: null,
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
      expect(Object.isFrozen(NO_POSTED_TIME)).toBe(true);
    });

    it('is never handed out by reference from a helper', () => {
      expect(postedFromTimestamp(null)).not.toBe(NO_POSTED_TIME);
      expect(postedFromRelativeLabel(null, FETCHED_AT)).not.toBe(NO_POSTED_TIME);
      expect(postedFromAgeInDays(null, FETCHED_AT)).not.toBe(NO_POSTED_TIME);
    });
  });

  describe('parseRelativeAge', () => {
    it.each<[string, number, string, string]>([
      ['26 minutes ago', 26, 'minute', 'ago'],
      ['1 hour ago', 1, 'hour', 'ago'],
      ['2 hours ago', 2, 'hour', 'ago'],
      ['1 hr ago', 1, 'hour', 'ago'],
      ['3 hrs ago', 3, 'hour', 'ago'],
      ['5 mins ago', 5, 'minute', 'ago'],
      ['1 min ago', 1, 'minute', 'ago'],
      ['30 seconds ago', 30, 'second', 'ago'],
      ['10 secs ago', 10, 'second', 'ago'],
      ['Just now', 0, 'second', 'now'],
      ['moments ago', 0, 'second', 'now'],
      ['an hour ago', 1, 'hour', 'ago'],
      ['a minute ago', 1, 'minute', 'ago'],
      ['2 days ago', 2, 'day', 'ago'],
      ['1 week ago', 1, 'week', 'ago'],
      ['2 wks ago', 2, 'week', 'ago'],
      ['3 months ago', 3, 'month', 'ago'],
      ['4 mos ago', 4, 'month', 'ago'],
      ['1 year ago', 1, 'year', 'ago'],
      ['2 yrs ago', 2, 'year', 'ago'],
      ['30+ days ago', 30, 'day', 'ago'],
      ['Posted 3 days ago', 3, 'day', 'ago'],
      ['Reposted 2 hours ago', 2, 'hour', 'ago'],
      ['today', 0, 'day', 'today'],
      ['Posted Today', 0, 'day', 'today'],
      ['yesterday', 1, 'day', 'yesterday'],
      ['9999 hours ago', 9999, 'hour', 'ago'],
    ])('parses %j', (text, amount, unit, label) => {
      expect(parseRelativeAge(text)).toEqual({ amount, unit, label });
    });

    it('is case-insensitive and tolerates the whitespace a <time> element carries', () => {
      expect(parseRelativeAge('\n\n   1 hour ago\n  ')).toEqual({ amount: 1, unit: 'hour', label: 'ago' });
      expect(parseRelativeAge('26   MINUTES\tAgo')).toEqual({ amount: 26, unit: 'minute', label: 'ago' });
      expect(parseRelativeAge('2 days ago')).toEqual({ amount: 2, unit: 'day', label: 'ago' });
    });

    it.each<[string, unknown]>([
      ['a localised label', 'vor 3 Stunden'],
      ['an unquantified label', 'Posted recently'],
      ['future phrasing', 'in 3 hours'],
      ['a future "from now" label', '3 hours from now'],
      ['an empty string', ''],
      ['whitespace only', '   \n '],
      ['null', null],
      ['undefined', undefined],
      ['a five-digit amount', '99999 years ago'],
      ['a negative amount', '-3 days ago'],
      ['trailing text', '3 days ago by Acme'],
      ['leading text', 'about 3 days ago'],
      ['a missing unit', '3 ago'],
      ['a non-string', 42],
      ['an over-long label', `${'1'.repeat(300)} days ago`],
    ])('returns null for %s', (_name, value) => {
      expect(parseRelativeAge(value as string)).toBeNull();
    });
  });

  describe('relativeAgeToMs', () => {
    it('uses 30-day months and 365-day years', () => {
      expect(relativeAgeToMs({ amount: 30, unit: 'second', label: 'ago' })).toBe(30_000);
      expect(relativeAgeToMs({ amount: 26, unit: 'minute', label: 'ago' })).toBe(26 * MIN);
      expect(relativeAgeToMs({ amount: 2, unit: 'hour', label: 'ago' })).toBe(2 * HOUR);
      expect(relativeAgeToMs({ amount: 1, unit: 'day', label: 'yesterday' })).toBe(DAY);
      expect(relativeAgeToMs({ amount: 2, unit: 'week', label: 'ago' })).toBe(14 * DAY);
      expect(relativeAgeToMs({ amount: 1, unit: 'month', label: 'ago' })).toBe(30 * DAY);
      expect(relativeAgeToMs({ amount: 1, unit: 'year', label: 'ago' })).toBe(365 * DAY);
      expect(relativeAgeToMs({ amount: 0, unit: 'second', label: 'now' })).toBe(0);
    });
  });

  describe('postedFromRelativeLabel', () => {
    type Row = [string | null, string | null, Partial<PostedTime>];
    // The probe tuples (fetched at 2026-09-24T20:00:03Z) plus edge cases.
    it.each<Row>([
      ['26 minutes ago', '2026-09-24', {
        datePosted: '2026-09-24', datePostedAt: '2026-09-24T19:34:00.000Z',
        datePostedPrecision: DatePostedPrecision.MINUTE, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['1 hour ago', '2026-09-24', {
        datePosted: '2026-09-24', datePostedAt: '2026-09-24T19:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.HOUR, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['2 days ago', '2026-09-22', {
        datePosted: '2026-09-22', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      // Probe regression: "1 week ago" was really 12 days; the attribute must win.
      ['1 week ago', '2026-09-12', {
        datePosted: '2026-09-12', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      ['2 weeks ago', '2026-09-04', {
        datePosted: '2026-09-04', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      // Inconsistent pair: the label is dropped, the attribute stands.
      ['1 hour ago', '2026-09-20', {
        datePosted: '2026-09-20', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      ['vor 3 Stunden', '2026-09-24', {
        datePosted: '2026-09-24', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      [null, '2026-09-24', {
        datePosted: '2026-09-24', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.DATE,
      }],
      ['3 hours ago', null, {
        datePosted: '2026-09-24', datePostedAt: '2026-09-24T17:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.HOUR, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['30 seconds ago', null, {
        datePosted: '2026-09-24', datePostedAt: '2026-09-24T19:59:00.000Z',
        datePostedPrecision: DatePostedPrecision.MINUTE, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['Just now', null, {
        datePosted: '2026-09-24', datePostedAt: '2026-09-24T20:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.MINUTE, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['2 weeks ago', null, {
        datePosted: '2026-09-10', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.WEEK, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['1 month ago', null, {
        datePosted: '2026-08-25', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.MONTH, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['1 year ago', null, {
        datePosted: '2025-09-24', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.YEAR, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['30+ days ago', null, {
        datePosted: '2026-08-25', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      // "today" can be 23 h old: a date, never an instant.
      ['today', null, {
        datePosted: '2026-09-24', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      ['yesterday', null, {
        datePosted: '2026-09-23', datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY, datePostedBasis: DatePostedBasis.RELATIVE,
      }],
      [null, null, { ...NO_POSTED_TIME }],
      ['Posted recently', null, { ...NO_POSTED_TIME }],
    ])('%j with hint %j', (label, hint, expected) => {
      const got = postedFromRelativeLabel(label, FETCHED_AT, hint);
      expect(got).toEqual(expected);
      expectInvariants(got);
    });

    it('accepts a sub-day label one UTC day away from the hint (unknown source time zone at midnight)', () => {
      const fetchedAt = Date.parse('2026-09-25T00:20:00Z');
      expect(postedFromRelativeLabel('1 hour ago', fetchedAt, '2026-09-25')).toEqual({
        datePosted: '2026-09-25',
        datePostedAt: '2026-09-24T23:20:00.000Z',
        datePostedPrecision: DatePostedPrecision.HOUR,
        datePostedBasis: DatePostedBasis.RELATIVE,
      });
      // …and the mirror image: a hint one day behind the label's UTC day.
      expect(postedFromRelativeLabel('5 minutes ago', fetchedAt, '2026-09-24').datePostedAt)
        .toBe('2026-09-25T00:15:00.000Z');
    });

    it('drops a sub-day label exactly two UTC days away from the hint', () => {
      const got = postedFromRelativeLabel('1 hour ago', FETCHED_AT, '2026-09-22');
      expect(got.datePostedAt).toBeNull();
      expect(got.datePostedBasis).toBe(DatePostedBasis.DATE);
    });

    it('never re-derives datePosted from the instant when the source gave a date', () => {
      // 23:30Z on the 24th is the 25th in a UTC+1 source; the attribute wins.
      const fetchedAt = Date.parse('2026-09-24T23:40:00Z');
      const got = postedFromRelativeLabel('10 minutes ago', fetchedAt, '2026-09-25');
      expect(got.datePosted).toBe('2026-09-25');
      expect(got.datePostedAt).toBe('2026-09-24T23:30:00.000Z');
    });

    it.each<[string, unknown]>([
      ['not a date', 'yesterday'],
      ['an impossible calendar date', '2026-02-30'],
      ['a datetime', '2026-09-24T10:00:00Z'],
      ['a number', 20260924],
    ])('ignores a hint that is %s', (_name, hint) => {
      const got = postedFromRelativeLabel('3 hours ago', FETCHED_AT, hint as string);
      expect(got.datePosted).toBe('2026-09-24');
      expect(got.datePostedAt).toBe('2026-09-24T17:00:00.000Z');
    });

    it('trims a hint before judging it', () => {
      expect(postedFromRelativeLabel('2 days ago', FETCHED_AT, ' 2026-09-22 \n').datePosted).toBe('2026-09-22');
    });

    it('refuses an absurd relative age that would predate 2000', () => {
      expect(postedFromRelativeLabel('9999 years ago', FETCHED_AT)).toEqual(NO_POSTED_TIME);
      expect(postedFromRelativeLabel('9999 years ago', FETCHED_AT, '2026-09-20')).toEqual({
        datePosted: '2026-09-20',
        datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
    });

    it('keeps a large hour count as hour precision (the label says hours)', () => {
      const got = postedFromRelativeLabel('48 hours ago', FETCHED_AT);
      expect(got.datePostedAt).toBe('2026-09-22T20:00:00.000Z');
      expect(got.datePostedPrecision).toBe(DatePostedPrecision.HOUR);
    });

    it('falls back to the hint (or nothing) when the fetch time is not a finite number', () => {
      expect(postedFromRelativeLabel('1 hour ago', Number.NaN, '2026-09-24')).toEqual({
        datePosted: '2026-09-24',
        datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
      expect(postedFromRelativeLabel('1 hour ago', Number.NaN)).toEqual(NO_POSTED_TIME);
    });
  });

  describe('postedAtAgreesWithDate', () => {
    it('accepts the same UTC day and one day either side, and nothing further', () => {
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', '2026-09-24')).toBe(true);
      expect(postedAtAgreesWithDate('2026-09-24T23:59:59.999Z', '2026-09-25')).toBe(true);
      expect(postedAtAgreesWithDate('2026-09-25T00:00:00.000Z', '2026-09-24')).toBe(true);
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', '2026-09-26')).toBe(false);
      expect(postedAtAgreesWithDate('2026-09-19T19:34:25.000Z', '2026-09-24')).toBe(false);
      expect(postedAtAgreesWithDate(Date.parse('2026-09-24T12:00:00Z'), '2026-09-23')).toBe(true);
    });

    it('takes an explicit tolerance', () => {
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', '2026-09-25', 0)).toBe(false);
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', '2026-09-19', 5)).toBe(true);
    });

    it('is false for anything unparseable', () => {
      expect(postedAtAgreesWithDate(null, '2026-09-24')).toBe(false);
      expect(postedAtAgreesWithDate('soon', '2026-09-24')).toBe(false);
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', null)).toBe(false);
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', '2026-02-30')).toBe(false);
      expect(postedAtAgreesWithDate('2026-09-24T19:34:25.000Z', 'Sep 24')).toBe(false);
    });
  });

  describe('postedFromTimestamp', () => {
    const EXACT_NOW: PostedTime = {
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T20:00:00.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
      datePostedBasis: DatePostedBasis.TIMESTAMP,
    };

    it('reads an epoch-milliseconds number as an exact instant', () => {
      expect(postedFromTimestamp(1790280000000, NOW)).toEqual(EXACT_NOW);
    });

    it('reads an epoch-seconds number as the same instant', () => {
      expect(postedFromTimestamp(1790280000, NOW)).toEqual(EXACT_NOW);
    });

    it('reads a numeric string (regression: toDateOnly returns null for it)', () => {
      expect(toDateOnly('1790280000000')).toBeNull();
      expect(postedFromTimestamp('1790280000000', NOW)).toEqual(EXACT_NOW);
      expect(postedFromTimestamp('1790280000', NOW)).toEqual(EXACT_NOW);
      expect(postedFromTimestamp(' 1790280000000\n', NOW)).toEqual(EXACT_NOW);
    });

    it('keeps the source local day for an offset timestamp (Spec 5024) and stores the UTC instant', () => {
      expect(postedFromTimestamp('2026-04-20T22:32:33-04:00', NOW)).toEqual({
        datePosted: '2026-04-20',
        datePostedAt: '2026-04-21T02:32:33.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      });
    });

    it.each<[string, string, string]>([
      ['2026-09-24T19:34:25.000Z', '2026-09-24', '2026-09-24T19:34:25.000Z'],
      ['2026-09-24T19:34:25Z', '2026-09-24', '2026-09-24T19:34:25.000Z'],
      ['2026-09-24T19:34Z', '2026-09-24', '2026-09-24T19:34:00.000Z'],
      ['2026-09-24T19:34:25.5Z', '2026-09-24', '2026-09-24T19:34:25.500Z'],
      ['2026-09-24T19:34:25.123456789Z', '2026-09-24', '2026-09-24T19:34:25.123Z'],
      ['2026-09-24 19:34:25+00:00', '2026-09-24', '2026-09-24T19:34:25.000Z'],
      ['2026-09-25T01:04:25+0530', '2026-09-25', '2026-09-24T19:34:25.000Z'],
      ['2026-09-25T04:34:25+09', '2026-09-25', '2026-09-24T19:34:25.000Z'],
      ['2026-09-24T19:34:25z', '2026-09-24', '2026-09-24T19:34:25.000Z'],
    ])('reads the offset form %j', (value, datePosted, at) => {
      const got = postedFromTimestamp(value, NOW);
      expect(got).toEqual({
        datePosted,
        datePostedAt: at,
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      });
      // The instant agrees with the platform parser wherever that is unambiguous.
      if (!/[+-]\d{2}$|[+-]\d{4}$|\d{4,}Z$/.test(value)) {
        expect(got.datePostedAt).toBe(new Date(value).toISOString());
      }
    });

    it('does not guess a zone for an offset-less datetime', () => {
      expect(postedFromTimestamp('2026-04-20T10:00:00', NOW)).toEqual({
        datePosted: '2026-04-20',
        datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
      expect(postedFromTimestamp('2026-04-20 10:00', NOW).datePostedAt).toBeNull();
    });

    it('reads a date-only string as day precision', () => {
      expect(postedFromTimestamp('2026-04-20', NOW)).toEqual({
        datePosted: '2026-04-20',
        datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
    });

    it('drops an instant more than 36 h in the future but keeps the date toDateOnly would give', () => {
      const future = NOW + 3 * DAY;
      expect(postedFromTimestamp(future, NOW)).toEqual({
        datePosted: toDateOnly(future),
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
      expect(postedFromTimestamp('2026-09-27T20:00:00Z', NOW)).toEqual({
        datePosted: '2026-09-27',
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
    });

    it('tolerates up to 36 h of clock skew into the future', () => {
      const got = postedFromTimestamp(NOW + 35 * HOUR, NOW);
      expect(got.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
    });

    it('drops an instant before 2000 but keeps the date toDateOnly would give', () => {
      expect(postedFromTimestamp('1999-12-31T00:00:00Z', NOW)).toEqual({
        datePosted: '1999-12-31',
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
      expect(postedFromTimestamp(0, NOW)).toEqual({
        datePosted: toDateOnly(0),
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
    });

    it('vouches for no precision on an implausible date-only value', () => {
      expect(postedFromTimestamp('1999-01-01', NOW)).toEqual({
        datePosted: '1999-01-01',
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
      expect(postedFromTimestamp('2026-09-30', NOW).datePostedPrecision).toBeNull();
      // Tomorrow's date is fine: a far-east source is already there.
      expect(postedFromTimestamp('2026-09-25', NOW).datePostedPrecision).toBe(DatePostedPrecision.DAY);
    });

    it('keeps toDateOnly behaviour, with no precision, for an impossible calendar date', () => {
      expect(postedFromTimestamp('2026-02-30T10:00:00Z', NOW)).toEqual({
        datePosted: toDateOnly('2026-02-30T10:00:00Z'),
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
      expect(postedFromTimestamp('2026-02-30', NOW).datePostedPrecision).toBeNull();
      expect(postedFromTimestamp('2026-09-24T25:00:00Z', NOW).datePostedAt).toBeNull();
    });

    it('treats a Date object as a date only — it may have been built from a date', () => {
      const got = postedFromTimestamp(new Date(NOW), NOW);
      expect(got).toEqual({
        datePosted: '2026-09-24',
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
    });

    it('falls back to toDateOnly, with no precision, for other parseable strings', () => {
      const value = 'Thu, 24 Sep 2026 12:00:00 GMT';
      expect(postedFromTimestamp(value, NOW)).toEqual({
        datePosted: toDateOnly(value),
        datePostedAt: null,
        datePostedPrecision: null,
        datePostedBasis: null,
      });
    });

    it.each<[string, unknown]>([
      ['garbage', 'garbage'],
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a boolean', true],
      ['an object', { datePosted: '2026-09-24' }],
    ])('gives all null for %s', (_name, value) => {
      expect(postedFromTimestamp(value, NOW)).toEqual(NO_POSTED_TIME);
    });

    it('defaults now to Date.now()', () => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        expect(postedFromTimestamp(1790280000000)).toEqual(EXACT_NOW);
        expect(postedFromTimestamp(NOW + 3 * DAY).datePostedAt).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('postedFromAgeInDays', () => {
    it.each<[unknown, string]>([
      [0, '2026-09-24'],
      [3, '2026-09-21'],
      ['3', '2026-09-21'],
      [' 5 ', '2026-09-19'],
      [3650, '2016-09-26'],
    ])('reads %j days', (days, datePosted) => {
      const got = postedFromAgeInDays(days, NOW);
      expect(got).toEqual({
        datePosted,
        datePostedAt: null,
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.RELATIVE,
      });
      expectInvariants(got);
    });

    it.each<[string, unknown]>([
      ['a negative age', -1],
      ['NaN', Number.NaN],
      ['null', null],
      ['undefined', undefined],
      ['an absurd age', 4000],
      ['just past the cap', 3650.5],
      ['a non-numeric string', 'three'],
      ['an empty string', ''],
      ['a boolean', true],
    ])('gives all null for %s', (_name, days) => {
      expect(postedFromAgeInDays(days, NOW)).toEqual(NO_POSTED_TIME);
    });

    it('gives all null when the fetch time is not finite', () => {
      expect(postedFromAgeInDays(3, Number.NaN)).toEqual(NO_POSTED_TIME);
    });

    it('matches the historical Date.now() - days * 86400000 arithmetic for every valid age', () => {
      const fetchedAt = Date.parse('2026-03-29T00:30:00Z');
      for (let days = 0; days <= 60; days += 1) {
        expect(postedFromAgeInDays(days, fetchedAt).datePosted)
          .toBe(toDateOnly(fetchedAt - days * 86400000));
      }
    });
  });

  describe('postedTimeFields', () => {
    const ORIGINAL_ENV = process.env[POSTED_TIME_DETAIL_ENV];
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env[POSTED_TIME_DETAIL_ENV];
      else process.env[POSTED_TIME_DETAIL_ENV] = ORIGINAL_ENV;
    });

    it('always carries datePosted, even when null, and nothing else for an empty result', () => {
      expect(postedTimeFields(NO_POSTED_TIME)).toEqual({ datePosted: null });
      expect(Object.keys(postedTimeFields(NO_POSTED_TIME))).toEqual(['datePosted']);
    });

    it('omits the keys that are null', () => {
      const fields = postedTimeFields(postedFromRelativeLabel('2 days ago', FETCHED_AT, '2026-09-22'));
      expect(fields).toEqual({
        datePosted: '2026-09-22',
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
      expect('datePostedAt' in fields).toBe(false);
    });

    it('carries all four keys for a sub-day result', () => {
      expect(postedTimeFields(postedFromRelativeLabel('26 minutes ago', FETCHED_AT, '2026-09-24'))).toEqual({
        datePosted: '2026-09-24',
        datePostedAt: '2026-09-24T19:34:00.000Z',
        datePostedPrecision: DatePostedPrecision.MINUTE,
        datePostedBasis: DatePostedBasis.RELATIVE,
      });
    });

    it('drops an instant whose precision is day or coarser', () => {
      expect(postedTimeFields({
        datePosted: '2026-09-24',
        datePostedAt: '2026-09-24T19:34:00.000Z',
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.RELATIVE,
      })).toEqual({
        datePosted: '2026-09-24',
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.RELATIVE,
      });
    });

    it('drops an instant that is not a parseable timestamp', () => {
      expect(postedTimeFields({
        datePosted: '2026-09-24',
        datePostedAt: 'soon',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      })).toEqual({
        datePosted: '2026-09-24',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      });
    });

    it('drops every detail key when datePosted is null', () => {
      expect(postedTimeFields({
        datePosted: null,
        datePostedAt: '2026-09-24T19:34:00.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      })).toEqual({ datePosted: null });
    });

    it('can be told to emit the pre-Spec-1696 shape (datePosted only)', () => {
      const p = postedFromTimestamp(1790280000000, NOW);
      expect(postedTimeFields(p, { detail: false })).toEqual({ datePosted: '2026-09-24' });
      expect(postedTimeFields(p, { detail: true })).toEqual(postedTimeFields(p));
    });

    it.each(['false', '0', 'off', 'no', ' FALSE '])(
      'honours %j in the kill-switch env var',
      (value) => {
        process.env[POSTED_TIME_DETAIL_ENV] = value;
        expect(postedTimeFields(postedFromTimestamp(1790280000000, NOW))).toEqual({ datePosted: '2026-09-24' });
      },
    );

    it.each(['true', '1', '', 'yes'])('keeps the detail keys when the env var is %j', (value) => {
      process.env[POSTED_TIME_DETAIL_ENV] = value;
      expect(Object.keys(postedTimeFields(postedFromTimestamp(1790280000000, NOW)))).toHaveLength(4);
    });

    it('lets an explicit option override the env var', () => {
      process.env[POSTED_TIME_DETAIL_ENV] = 'false';
      expect(Object.keys(postedTimeFields(postedFromTimestamp(1790280000000, NOW), { detail: true })))
        .toHaveLength(4);
    });
  });

  describe('postedSortKey', () => {
    it('prefers datePostedAt over datePosted', () => {
      expect(postedSortKey({ datePosted: '2026-09-24', datePostedAt: '2026-09-24T19:34:00.000Z' }))
        .toBe(Date.parse('2026-09-24T19:34:00.000Z'));
    });

    it('puts a date-only row at 00:00Z of its day', () => {
      expect(postedSortKey({ datePosted: '2026-09-24' })).toBe(Date.UTC(2026, 8, 24));
    });

    it('accepts a Date object', () => {
      expect(postedSortKey({ datePosted: new Date(Date.UTC(2026, 8, 24, 5)) })).toBe(Date.UTC(2026, 8, 24, 5));
    });

    it('falls back to datePosted when datePostedAt is junk', () => {
      expect(postedSortKey({ datePosted: '2026-09-24', datePostedAt: 'soon' })).toBe(Date.UTC(2026, 8, 24));
    });

    it.each<[string, unknown]>([
      ['a junk string', 'Posted 3 Days Ago'],
      ['null', null],
      ['undefined', undefined],
      ['an invalid Date', new Date('nope')],
      ['an object', {}],
    ])('gives 0 (finite) for %s', (_name, datePosted) => {
      const key = postedSortKey({ datePosted: datePosted as string });
      expect(key).toBe(0);
      expect(Number.isFinite(key)).toBe(true);
    });

    it('gives a deterministic newest-first order across mixed precision and junk', () => {
      const jobs = [
        { id: 'junk', datePosted: 'Posted 3 Days Ago' },
        { id: 'am', datePosted: '2026-09-24', datePostedAt: '2026-09-24T10:00:00.000Z' },
        { id: 'day', datePosted: '2026-09-23' },
        { id: 'pm', datePosted: '2026-09-24', datePostedAt: '2026-09-24T19:34:00.000Z' },
        { id: 'none', datePosted: null },
      ];
      const order = [...jobs].sort((a, b) => postedSortKey(b) - postedSortKey(a)).map((j) => j.id);
      expect(order).toEqual(['pm', 'am', 'day', 'junk', 'none']);
    });
  });

  describe('invariants hold across every helper', () => {
    const labels = [
      '26 minutes ago', '1 hour ago', 'Just now', '2 days ago', '1 week ago', 'today', 'yesterday',
      'vor 3 Stunden', '', null, '9999 hours ago', '9999 years ago', '30+ days ago',
    ];
    const hints = ['2026-09-24', '2026-09-12', '2026-02-30', null];
    const timestamps: unknown[] = [
      1790280000000, 1790280000, '1790280000000', '2026-04-20T22:32:33-04:00', '2026-04-20T10:00:00',
      '2026-04-20', NOW + 3 * DAY, '1999-12-31T00:00:00Z', 'garbage', null, new Date(NOW), -5,
      Number.MAX_SAFE_INTEGER,
    ];

    it('for relative labels', () => {
      for (const label of labels) {
        for (const hint of hints) expectInvariants(postedFromRelativeLabel(label, FETCHED_AT, hint));
      }
    });

    it('for timestamps', () => {
      for (const value of timestamps) expectInvariants(postedFromTimestamp(value, NOW));
    });

    it('for day buckets', () => {
      for (const days of [0, 1, 7, 30, 3650, -1, 4000, 'x', null]) {
        expectInvariants(postedFromAgeInDays(days, NOW));
      }
    });

    it('never throws, even for a clock beyond what a Date can hold', () => {
      const huge = 1e20;
      expect(() => postedFromTimestamp(Number.MAX_SAFE_INTEGER, huge)).not.toThrow();
      expect(() => postedFromTimestamp('9999999999999', huge)).not.toThrow();
      expect(() => postedFromTimestamp('275760-09-14T00:00:00Z', huge)).not.toThrow();
      expect(postedFromRelativeLabel('1 hour ago', huge)).toEqual(NO_POSTED_TIME);
      expect(postedFromRelativeLabel('2 days ago', huge, '2026-09-24').datePosted).toBe('2026-09-24');
      expect(postedFromAgeInDays(3, huge)).toEqual(NO_POSTED_TIME);
      expect(postedTimeFields(postedFromTimestamp(Number.MAX_SAFE_INTEGER, huge))).toEqual({ datePosted: null });
    });
  });
});
