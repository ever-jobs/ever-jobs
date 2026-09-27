import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  parseWorkdayPostedOn,
  resolveWorkdayBoardToday,
  workdayPostedOnDaysAgo,
  parseWorkdaySlug,
  buildWorkdayUrl,
  buildWorkdayDetailUrl,
  WORKDAY_DETAIL_CONCURRENCY,
  WORKDAY_DETAIL_DELAY_MIN_MS,
  WORKDAY_DETAIL_DELAY_MAX_MS,
  workdaySearchText,
  workdayListingRequisitionId,
  hasWorkdayLocationShape,
  splitWorkdayAdditionalLocations,
  workdayListingLocationLabel,
  workdayImpliedCountryCode,
  readWorkdayMaxDetailFetches,
  readWorkdayScrapeTimeBudgetMs,
  readFanoutDeadlineHintMs,
  resolveWorkdayScrapeTimeBudget,
  FANOUT_DEADLINE_ENV_VAR,
  LEGACY_FANOUT_DEADLINE_ENV_VAR,
  DEFAULT_FANOUT_DEADLINE_MS,
  WORKDAY_BUDGET_SHARE_OF_FANOUT_DEADLINE,
  DEFAULT_WORKDAY_MAX_DETAIL_FETCHES,
  DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS,
  WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR,
  WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR,
} from '../src/workday.constants';
import type { TimeZoneResult } from './support/workday-dates-in-time-zones';

/**
 * Spec 720 / T04 — `parseWorkdayPostedOn` branch-exhaustive unit tests.
 *
 * Every case injects a fixed `now` so results are deterministic without
 * fake timers. `NOW` is mid-day UTC to keep day arithmetic unambiguous.
 */
describe('parseWorkdayPostedOn — Spec 720 / T04', () => {
  const NOW = new Date('2026-06-11T12:00:00Z');

  describe('"Posted Today" (FR-2)', () => {
    it('returns the ISO date of now', () => {
      expect(parseWorkdayPostedOn('Posted Today', NOW)).toBe('2026-06-11');
    });

    it('is case-insensitive and whitespace-tolerant (FR-6)', () => {
      expect(parseWorkdayPostedOn('  POSTED   today ', NOW)).toBe('2026-06-11');
      expect(parseWorkdayPostedOn('posted TODAY', NOW)).toBe('2026-06-11');
    });

    it('defaults now to the current time when omitted', () => {
      const before = new Date().toISOString().split('T')[0];
      const result = parseWorkdayPostedOn('Posted Today');
      const after = new Date().toISOString().split('T')[0];
      expect([before, after]).toContain(result);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('"Posted Yesterday" (FR-3)', () => {
    it('returns now minus 1 day', () => {
      expect(parseWorkdayPostedOn('Posted Yesterday', NOW)).toBe('2026-06-10');
    });

    it('is case-insensitive and whitespace-tolerant (FR-6)', () => {
      expect(parseWorkdayPostedOn('   posted   YESTERDAY  ', NOW)).toBe('2026-06-10');
    });
  });

  describe('"Posted N Days Ago" (FR-4)', () => {
    it('returns now minus N days', () => {
      expect(parseWorkdayPostedOn('Posted 3 Days Ago', NOW)).toBe('2026-06-08');
      expect(parseWorkdayPostedOn('Posted 14 Days Ago', NOW)).toBe('2026-05-28');
    });

    it('accepts the singular "1 Day Ago"', () => {
      expect(parseWorkdayPostedOn('Posted 1 Day Ago', NOW)).toBe('2026-06-10');
    });

    it('is case-insensitive and whitespace-tolerant (FR-6)', () => {
      expect(parseWorkdayPostedOn('  posted   7   DAYS   ago ', NOW)).toBe('2026-06-04');
    });

    it('subtracts across a month boundary', () => {
      const monthStart = new Date('2026-06-01T00:30:00Z');
      expect(parseWorkdayPostedOn('Posted 3 Days Ago', monthStart)).toBe('2026-05-29');
    });

    it('returns null (without throwing) when N leaves the representable date range (§7.2)', () => {
      expect(parseWorkdayPostedOn('Posted 999999999 Days Ago', NOW)).toBeNull();
    });
  });

  describe('"Posted N+ Days Ago" (FR-5)', () => {
    it('returns null — the label is a lower bound, not an exact date', () => {
      expect(parseWorkdayPostedOn('Posted 30+ Days Ago', NOW)).toBeNull();
      expect(parseWorkdayPostedOn('posted 7+ days ago', NOW)).toBeNull();
    });
  });

  describe('ISO absolute-date fallback (FR-7)', () => {
    it('returns the ISO date for an ISO-shaped absolute date', () => {
      expect(parseWorkdayPostedOn('2026-05-20', NOW)).toBe('2026-05-20');
    });

    it('returns the ISO calendar date for an ISO datetime', () => {
      expect(parseWorkdayPostedOn('2026-05-20T08:30:00Z', NOW)).toBe('2026-05-20');
    });

    it('returns null for non-ISO absolute dates (host-TZ-dependent under Date.parse, NFR-3)', () => {
      expect(parseWorkdayPostedOn('May 20, 2026', NOW)).toBeNull();
      expect(parseWorkdayPostedOn('20 May 2026', NOW)).toBeNull();
    });

    it('returns null for ISO-shaped but impossible calendar dates', () => {
      expect(parseWorkdayPostedOn('2026-02-30', NOW)).toBeNull();
      expect(parseWorkdayPostedOn('2026-13-01', NOW)).toBeNull();
    });

    it('returns null for unparseable strings', () => {
      expect(parseWorkdayPostedOn('Just Posted', NOW)).toBeNull();
      expect(parseWorkdayPostedOn('N/A', NOW)).toBeNull();
    });
  });

  describe('nullish / empty input (FR-8)', () => {
    it('returns null for null', () => {
      expect(parseWorkdayPostedOn(null, NOW)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
    });

    it('returns null for empty and whitespace-only strings', () => {
      expect(parseWorkdayPostedOn('', NOW)).toBeNull();
      expect(parseWorkdayPostedOn('   ', NOW)).toBeNull();
    });
  });
});

describe('workdayPostedOnDaysAgo — Spec 1736 T17', () => {
  it('counts the days a relative label names', () => {
    expect(workdayPostedOnDaysAgo('Posted Today')).toBe(0);
    expect(workdayPostedOnDaysAgo('  posted   YESTERDAY ')).toBe(1);
    expect(workdayPostedOnDaysAgo('Posted 1 Day Ago')).toBe(1);
    expect(workdayPostedOnDaysAgo('Posted 3 Days Ago')).toBe(3);
    expect(workdayPostedOnDaysAgo('posted 29 days ago')).toBe(29);
  });

  it('gives no count for an open bound, an absolute date, other text or nothing', () => {
    expect(workdayPostedOnDaysAgo('Posted 30+ Days Ago')).toBeNull();
    expect(workdayPostedOnDaysAgo('2026-09-25')).toBeNull();
    expect(workdayPostedOnDaysAgo('Just Posted')).toBeNull();
    expect(workdayPostedOnDaysAgo('Posted 99999999999999999999 Days Ago')).toBeNull();
    expect(workdayPostedOnDaysAgo('')).toBeNull();
    expect(workdayPostedOnDaysAgo(null)).toBeNull();
    expect(workdayPostedOnDaysAgo(undefined)).toBeNull();
  });
});

describe('parseWorkdayPostedOn around UTC midnight — Spec 1736 T17', () => {
  it('counts back from the UTC date of `now`, either side of UTC midnight', () => {
    const justBefore = new Date('2026-09-25T23:59:59.999Z');
    const justAfter = new Date('2026-09-26T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted Today', justBefore)).toBe('2026-09-25');
    expect(parseWorkdayPostedOn('Posted Today', justAfter)).toBe('2026-09-26');
    expect(parseWorkdayPostedOn('Posted Yesterday', justAfter)).toBe('2026-09-25');
    expect(parseWorkdayPostedOn('Posted 3 Days Ago', justAfter)).toBe('2026-09-23');
    expect(parseWorkdayPostedOn('2026-09-25T22:30:00-04:00', justAfter)).toBe('2026-09-25');
  });

  it("counts back from the board's own date when given it", () => {
    // Moderna at 00:42 UTC on the 26th: still the 25th in Massachusetts.
    const board = resolveWorkdayBoardToday(
      [{ postedOn: 'Posted Today', startDate: '2026-09-25' }],
      new Date('2026-09-26T00:42:22Z'),
    );
    expect(board?.date).toBe('2026-09-25');
    expect(parseWorkdayPostedOn('Posted Today', board?.reference)).toBe('2026-09-25');
    expect(parseWorkdayPostedOn('Posted Yesterday', board?.reference)).toBe('2026-09-24');
    expect(parseWorkdayPostedOn('Posted 2 Days Ago', board?.reference)).toBe('2026-09-23');
    expect(parseWorkdayPostedOn('Posted 30+ Days Ago', board?.reference)).toBeNull();
  });
});

describe('resolveWorkdayBoardToday — Spec 1736 T17', () => {
  /** The recorded Moderna rows at 01:33 UTC on 2026-09-26: label and detail startDate. */
  const MODERNA_AFTER_UTC_MIDNIGHT = [
    { postedOn: 'Posted Today', startDate: '2026-09-25' },
    { postedOn: 'Posted Yesterday', startDate: '2026-09-24' },
    { postedOn: 'Posted 2 Days Ago', startDate: '2026-09-23' },
    { postedOn: 'Posted 3 Days Ago', startDate: '2026-09-22' },
  ];

  it('dates a board behind UTC just after UTC midnight (US Eastern)', () => {
    for (const now of ['2026-09-26T00:00:00Z', '2026-09-26T01:33:19Z', '2026-09-26T03:59:59Z']) {
      expect(resolveWorkdayBoardToday(MODERNA_AFTER_UTC_MIDNIGHT, new Date(now))).toEqual({
        date: '2026-09-25',
        reference: new Date('2026-09-25T00:00:00Z'),
        offsetDays: -1,
        votes: 4,
        samples: 4,
      });
    }
  });

  it("dates the same board on UTC's date just before UTC midnight", () => {
    const board = resolveWorkdayBoardToday(MODERNA_AFTER_UTC_MIDNIGHT, new Date('2026-09-25T23:59:59Z'));
    expect(board).toMatchObject({ date: '2026-09-25', offsetDays: 0, votes: 4, samples: 4 });
  });

  it('dates a board ahead of UTC (Tokyo, 05:00 on the 26th)', () => {
    const board = resolveWorkdayBoardToday(
      [
        { postedOn: 'Posted Today', startDate: '2026-09-26' },
        { postedOn: 'Posted 4 Days Ago', startDate: '2026-09-22T00:00:00.000+09:00' },
      ],
      new Date('2026-09-25T20:00:00Z'),
    );
    expect(board).toMatchObject({ date: '2026-09-26', offsetDays: 1, votes: 2, samples: 2 });
    expect(board?.reference.toISOString()).toBe('2026-09-26T00:00:00.000Z');
  });

  it('returns null when no sample dates the board', () => {
    const now = new Date('2026-09-26T00:42:22Z');
    expect(resolveWorkdayBoardToday([], now)).toBeNull();
    expect(
      resolveWorkdayBoardToday(
        [
          { postedOn: 'Posted 30+ Days Ago', startDate: '2026-08-01' },
          { postedOn: 'Posted Today', startDate: null },
          { postedOn: 'Posted Today' },
          { postedOn: 'Posted Today', startDate: 'September 25, 2026' },
          { postedOn: 'Posted Today', startDate: '2026-02-30' },
          { postedOn: null, startDate: '2026-09-25' },
          { postedOn: '2026-09-25', startDate: '2026-09-25' },
        ],
        now,
      ),
    ).toBeNull();
    expect(resolveWorkdayBoardToday(MODERNA_AFTER_UTC_MIDNIGHT, new Date(Number.NaN))).toBeNull();
  });

  it('ignores a sample more than a day off UTC (a repost), whatever it says', () => {
    const now = new Date('2026-09-26T00:42:22Z');
    expect(resolveWorkdayBoardToday([{ postedOn: 'Posted Today', startDate: '2026-08-03' }], now)).toBeNull();
    expect(resolveWorkdayBoardToday([{ postedOn: 'Posted Yesterday', startDate: '2026-09-27' }], now)).toBeNull();
    expect(
      resolveWorkdayBoardToday([{ postedOn: 'Posted Today', startDate: '2026-08-03' }, ...MODERNA_AFTER_UTC_MIDNIGHT], now),
    ).toMatchObject({ date: '2026-09-25', votes: 4, samples: 4 });
  });

  it("takes the date most samples give; a tie goes to UTC's date, then the earlier", () => {
    const now = new Date('2026-09-26T00:42:22Z');
    const behind = { postedOn: 'Posted Today', startDate: '2026-09-25' };
    const onUtc = { postedOn: 'Posted Today', startDate: '2026-09-26' };
    const ahead = { postedOn: 'Posted Today', startDate: '2026-09-27' };
    expect(resolveWorkdayBoardToday([onUtc, behind, behind], now)).toMatchObject({ offsetDays: -1, votes: 2, samples: 3 });
    expect(resolveWorkdayBoardToday([behind, onUtc], now)).toMatchObject({ offsetDays: 0, votes: 1, samples: 2 });
    expect(resolveWorkdayBoardToday([ahead, behind], now)).toMatchObject({ offsetDays: -1, date: '2026-09-25' });
  });
});

describe('existing pure helpers — regression', () => {
  it('parseWorkdaySlug splits the compound slug with defaults', () => {
    expect(parseWorkdaySlug('tesla:5:Tesla')).toEqual({
      company: 'tesla',
      wdNumber: '5',
      site: 'Tesla',
    });
    expect(parseWorkdaySlug('acme')).toEqual({
      company: 'acme',
      wdNumber: '5',
      site: 'External',
    });
  });

  it('buildWorkdayUrl builds the CXS jobs endpoint', () => {
    expect(buildWorkdayUrl('tesla', '5', 'Tesla')).toBe(
      'https://tesla.wd5.myworkdayjobs.com/wday/cxs/tesla/Tesla/jobs',
    );
  });

  it('buildWorkdayDetailUrl appends the external path below the career site', () => {
    expect(
      buildWorkdayDetailUrl(
        'xenergy',
        '5',
        'X-energyUS',
        '/job/Rockville-MD/Engineer_R101',
      ),
    ).toBe(
      'https://xenergy.wd5.myworkdayjobs.com/wday/cxs/xenergy/X-energyUS/job/Rockville-MD/Engineer_R101',
    );
    expect(buildWorkdayDetailUrl('acme', '1', 'External', 'job/Test_R1')).toBe(
      'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Test_R1',
    );
  });

  // Spec 1736 T8 / Spec 1735 §4.6: 55 company plugins bring Workday into every
  // default search, so detail enrichment is one request at a time, paced.
  it('enriches details one request at a time, with a small pause', () => {
    expect(WORKDAY_DETAIL_CONCURRENCY).toBe(1);
    expect(WORKDAY_DETAIL_DELAY_MIN_MS).toBe(250);
    expect(WORKDAY_DETAIL_DELAY_MAX_MS).toBe(500);
    expect(WORKDAY_DETAIL_DELAY_MAX_MS).toBeGreaterThanOrEqual(WORKDAY_DETAIL_DELAY_MIN_MS);
  });
});

/** Spec 1736 T6 — the keyword reaches Workday; list mode sends an empty search. */
describe('workdaySearchText', () => {
  it('sends the trimmed search term', () => {
    expect(workdaySearchText('  software engineer intern ')).toBe('software engineer intern');
    expect(workdaySearchText('C++')).toBe('C++');
  });

  it('sends an empty search in list mode (absent, null, empty or whitespace)', () => {
    expect(workdaySearchText(undefined)).toBe('');
    expect(workdaySearchText(null)).toBe('');
    expect(workdaySearchText('')).toBe('');
    expect(workdaySearchText(' \t\n ')).toBe('');
  });

  it('never serialises a non-string term as undefined or null text', () => {
    expect(workdaySearchText(42 as unknown as string)).toBe('');
    expect(workdaySearchText({} as unknown as string)).toBe('');
  });
});

/** Spec 1736 T11 — per-scrape detail cap and time budget, read from the env. */
describe('readWorkdayMaxDetailFetches', () => {
  const read = (value?: string) =>
    readWorkdayMaxDetailFetches(value === undefined ? {} : { [WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR]: value });

  it('names the variable and defaults to 50', () => {
    expect(WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR).toBe('WORKDAY_MAX_DETAIL_FETCHES');
    expect(DEFAULT_WORKDAY_MAX_DETAIL_FETCHES).toBe(50);
    expect(read()).toBe(50);
    expect(read('')).toBe(50);
    expect(read('   ')).toBe(50);
  });

  it('accepts a non-negative integer, 0 meaning no detail requests', () => {
    expect(read('0')).toBe(0);
    expect(read(' 7 ')).toBe(7);
    expect(read('+12')).toBe(12);
    expect(read('100000')).toBe(100000);
  });

  it('falls back to the default for anything else', () => {
    for (const value of ['-1', '1.5', 'abc', '1e3', '0x10', '50 jobs', '99999999999999999999']) {
      expect(read(value)).toBe(50);
    }
  });

  it('reads process.env by default', () => {
    const saved = process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
    try {
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '3';
      expect(readWorkdayMaxDetailFetches()).toBe(3);
    } finally {
      if (saved === undefined) delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      else process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = saved;
    }
  });
});

describe('readWorkdayScrapeTimeBudgetMs', () => {
  const read = (value?: string) =>
    readWorkdayScrapeTimeBudgetMs(value === undefined ? {} : { [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: value });

  it('names the variable and defaults to 90 s, below the 120 s fan-out deadline', () => {
    expect(WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR).toBe('WORKDAY_SCRAPE_TIME_BUDGET_MS');
    expect(DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS).toBe(90_000);
    expect(DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS).toBeLessThan(120_000);
    expect(read()).toBe(90_000);
    expect(read('')).toBe(90_000);
  });

  it('accepts a positive integer number of milliseconds', () => {
    expect(read('30000')).toBe(30_000);
    expect(read(' 1 ')).toBe(1);
  });

  it('treats 0 or a negative value as no budget (returns 0)', () => {
    expect(read('0')).toBe(0);
    expect(read('-1')).toBe(0);
    expect(read('-60000')).toBe(0);
  });

  it('falls back to the default for anything that is not an integer', () => {
    for (const value of ['abc', '1.5', '90s', '1e5', '99999999999999999999']) {
      expect(read(value)).toBe(90_000);
    }
  });
});

describe('workdayListingRequisitionId', () => {
  it('takes the first bullet that is a single token containing a digit', () => {
    expect(
      workdayListingRequisitionId({
        bulletFields: ['Spotlight Job', 'Posting End Date: 09/30/2026', 'JR0271234', 'R999'],
        externalPath: '/job/Santa-Clara/Engineer_JR0271234',
      }),
    ).toBe('JR0271234');
    expect(
      workdayListingRequisitionId({ bulletFields: ['  R-2012345  '], externalPath: '/job/X/Role_R-2012345' }),
    ).toBe('R-2012345');
  });

  it('skips non-string bullets', () => {
    expect(
      workdayListingRequisitionId({ bulletFields: [42, null, 'R1'] as unknown[], externalPath: '/job/X/Role_R1' }),
    ).toBe('R1');
  });

  describe('only a bullet that appears in the detail path (Spec 1736 T14)', () => {
    it('takes a bullet found in the path as a whole token, case-insensitively', () => {
      // Recorded Moderna row, 2026-09-25: location, department, requisition id.
      expect(
        workdayListingRequisitionId({
          bulletFields: ['Norwood, Massachusetts', 'Drug Manufacturing', 'R19827'],
          externalPath: '/job/Norwood-Massachusetts/Sr-Specialist--Maintenance_R19827',
        }),
      ).toBe('R19827');
      expect(
        workdayListingRequisitionId({ bulletFields: ['jr0271234'], externalPath: '/job/X/Engineer_JR0271234' }),
      ).toBe('jr0271234');
      // The numeric-segment layout: the id sits between slashes.
      expect(
        workdayListingRequisitionId({ bulletFields: ['12345'], externalPath: '/job/Austin-TX/Engineer/12345?src=x' }),
      ).toBe('12345');
    });

    it('skips a digit-bearing bullet that is not in the path, then takes the path suffix', () => {
      expect(
        workdayListingRequisitionId({ bulletFields: ['2026', 'Q3-2026'], externalPath: '/job/X/Role_R-7788' }),
      ).toBe('R-7788');
      // Not a whole token: "R1000" only occurs inside "JR1000".
      expect(workdayListingRequisitionId({ bulletFields: ['R1000'], externalPath: '/job/X/Role_JR1000' })).toBe(
        'JR1000',
      );
      // Only in the query string, which is not part of the path.
      expect(
        workdayListingRequisitionId({ bulletFields: ['R55'], externalPath: '/job/X/Some_Title?ref=R55' }),
      ).toBeNull();
    });

    it('accepts no bullet without a detail path', () => {
      expect(workdayListingRequisitionId({ bulletFields: ['R-2012345'] })).toBeNull();
      expect(workdayListingRequisitionId({ bulletFields: ['R-2012345'], externalPath: '' })).toBeNull();
    });
  });

  it("falls back to the detail path's trailing _<id> suffix", () => {
    expect(workdayListingRequisitionId({ externalPath: '/job/Santa-Clara/Software-Engineer_JR0271234' })).toBe(
      'JR0271234',
    );
    expect(workdayListingRequisitionId({ bulletFields: ['Exempt'], externalPath: '/job/X/Role_R-1234-1' })).toBe(
      'R-1234-1',
    );
    expect(workdayListingRequisitionId({ externalPath: '/job/X/Role_R123?source=feed' })).toBe('R123');
  });

  it('returns null when neither carries an id', () => {
    expect(workdayListingRequisitionId({})).toBeNull();
    expect(workdayListingRequisitionId({ bulletFields: ['Remote'], externalPath: '/job/X/Some_Title' })).toBeNull();
    expect(workdayListingRequisitionId({ externalPath: '/job/X/No-Suffix-123' })).toBeNull();
  });
});

/** Spec 1736 T12 — which labels count as places. */
describe('hasWorkdayLocationShape', () => {
  it('accepts labels the shared parser reads a state, a country or remote work from', () => {
    for (const label of [
      'Norwood, Massachusetts',
      'Cambridge, Massachusetts',
      'Rockville, MD',
      'Warsaw - Poland',
      'Melbourne - Australia',
      'Hong Kong',
      'Singapore',
      'Remote - US',
      'Remote_USA',
      'USA - CA - San Jose',
      'Texas',
    ]) {
      expect([label, hasWorkdayLocationShape(label)]).toEqual([label, true]);
    }
  });

  it('accepts a US state or a UK nation the parser keeps as a site name', () => {
    expect(hasWorkdayLocationShape('Oxford - England')).toBe(true);
    expect(hasWorkdayLocationShape('London - England')).toBe(true);
    expect(hasWorkdayLocationShape('Austin - TX')).toBe(true);
  });

  it('rejects departments, badges, counts and bare cities', () => {
    for (const label of [
      'Drug Manufacturing',
      'Technical Development',
      'Clinical Development',
      'Digital',
      'Engineering - Software',
      'Spotlight Job',
      'Posting End Date: 09/30/2026',
      'R19827',
      '2 Locations',
      'Norwood',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect([label, hasWorkdayLocationShape(label)]).toEqual([label, false]);
    }
  });
});

describe('splitWorkdayAdditionalLocations', () => {
  it("rejects the department Moderna files under additionalLocations", () => {
    expect(splitWorkdayAdditionalLocations('Norwood, Massachusetts', ['Drug Manufacturing'])).toEqual({
      locations: [],
      rejected: ['Drug Manufacturing'],
    });
  });

  it('keeps every entry with a location shape, in order, normalised', () => {
    expect(
      splitWorkdayAdditionalLocations('Rockville, MD', [
        'Oak Ridge, TN',
        'Drug Manufacturing',
        'Remote_USA',
        '  Oxford  -  England ',
      ]),
    ).toEqual({ locations: ['Oak Ridge, TN', 'Remote USA', 'Oxford - England'], rejected: ['Drug Manufacturing'] });
  });

  it('keeps bare entries when the primary is itself a bare site name', () => {
    expect(splitWorkdayAdditionalLocations('Bengaluru', ['Hyderabad'])).toEqual({
      locations: ['Hyderabad'],
      rejected: [],
    });
  });

  it('rejects bare entries when there is no primary to compare with', () => {
    expect(splitWorkdayAdditionalLocations(null, ['Drug Manufacturing', 'Cambridge, Massachusetts'])).toEqual({
      locations: ['Cambridge, Massachusetts'],
      rejected: ['Drug Manufacturing'],
    });
  });

  it('skips blank and non-string entries and a missing list', () => {
    expect(splitWorkdayAdditionalLocations('Rockville, MD', ['', '  ', 42, null] as unknown[])).toEqual({
      locations: [],
      rejected: [],
    });
    expect(splitWorkdayAdditionalLocations('Rockville, MD', null)).toEqual({ locations: [], rejected: [] });
  });
});

/** Spec 1736 T13 — the row's own place, for a posting returned at list level. */
describe('workdayListingLocationLabel', () => {
  // Recorded Moderna row, 2026-09-25: no locationsText.
  const MODERNA_ROW = {
    externalPath: '/job/Norwood-Massachusetts/Sr-Specialist--Maintenance_R19827',
    bulletFields: ['Norwood, Massachusetts', 'Drug Manufacturing', 'R19827'],
  };

  it('takes the location bullet when locationsText is missing', () => {
    expect(workdayListingLocationLabel(MODERNA_ROW)).toBe('Norwood, Massachusetts');
    expect(workdayListingLocationLabel({ ...MODERNA_ROW, locationsText: '   ' })).toBe('Norwood, Massachusetts');
    expect(workdayListingLocationLabel({ ...MODERNA_ROW, locationsText: null })).toBe('Norwood, Massachusetts');
  });

  it('skips the requisition id and bullets without a location shape, wherever the place sits', () => {
    expect(
      workdayListingLocationLabel({
        externalPath: '/job/X/Role_JR1',
        bulletFields: ['JR1', 'Spotlight Job', 'Drug Manufacturing', 'Warsaw - Poland'],
      }),
    ).toBe('Warsaw - Poland');
    expect(
      workdayListingLocationLabel({ externalPath: '/job/X/Role_R2', bulletFields: ['Drug Manufacturing', 'R2'] }),
    ).toBeNull();
  });

  it('prefers locationsText, returned as given', () => {
    expect(workdayListingLocationLabel({ ...MODERNA_ROW, locationsText: ' Cambridge, Massachusetts ' })).toBe(
      'Cambridge, Massachusetts',
    );
    // The count is dropped by the caller, not replaced by a bullet.
    expect(workdayListingLocationLabel({ ...MODERNA_ROW, locationsText: '2 Locations' })).toBe('2 Locations');
  });

  it('returns null without either', () => {
    expect(workdayListingLocationLabel({})).toBeNull();
    expect(workdayListingLocationLabel({ bulletFields: [42, null] as unknown[] })).toBeNull();
  });
});

describe('workdayImpliedCountryCode', () => {
  it('implies US for a site in one of the 50 states or DC with no country', () => {
    expect(workdayImpliedCountryCode({ city: 'Norwood', state: 'MA' } as never)).toBe('US');
    expect(workdayImpliedCountryCode({ state: 'dc' })).toBe('US');
  });

  it('implies nothing with a country, without a state, or for a territory or non-US code', () => {
    expect(workdayImpliedCountryCode({ state: 'MA', country: 'United States' })).toBeNull();
    expect(workdayImpliedCountryCode({ state: null })).toBeNull();
    expect(workdayImpliedCountryCode({ state: 'PR' })).toBeNull();
    expect(workdayImpliedCountryCode({ state: 'MH' })).toBeNull();
    expect(workdayImpliedCountryCode({ state: 'ON' })).toBeNull();
    expect(workdayImpliedCountryCode(null)).toBeNull();
  });
});

/** Spec 1736 T15 — the fan-out deadline as a hint that caps the Workday budget. */
describe('readFanoutDeadlineHintMs', () => {
  it('reads the preferred name, then the fallback name, then 120 s', () => {
    expect(DEFAULT_FANOUT_DEADLINE_MS).toBe(120_000);
    expect(readFanoutDeadlineHintMs({})).toBe(120_000);
    expect(readFanoutDeadlineHintMs({ [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '90000' })).toBe(90_000);
    expect(
      readFanoutDeadlineHintMs({ [FANOUT_DEADLINE_ENV_VAR]: '600000', [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '90000' }),
    ).toBe(600_000);
  });

  it('falls through a blank or non-numeric value, as the API does', () => {
    expect(
      readFanoutDeadlineHintMs({ [FANOUT_DEADLINE_ENV_VAR]: ' ', [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '90000' }),
    ).toBe(90_000);
    expect(readFanoutDeadlineHintMs({ [FANOUT_DEADLINE_ENV_VAR]: 'soon' })).toBe(120_000);
  });

  it('returns 0 for a disabled deadline (0 or negative) and floors the rest', () => {
    expect(readFanoutDeadlineHintMs({ [FANOUT_DEADLINE_ENV_VAR]: '0', [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '90000' })).toBe(0);
    expect(readFanoutDeadlineHintMs({ [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '-1' })).toBe(0);
    expect(readFanoutDeadlineHintMs({ [FANOUT_DEADLINE_ENV_VAR]: ' 150000.9 ' })).toBe(150_000);
  });
});

describe('resolveWorkdayScrapeTimeBudget', () => {
  it('keeps the 90 s default under the default 120 s deadline (3/4 of it, not lowered)', () => {
    expect(WORKDAY_BUDGET_SHARE_OF_FANOUT_DEADLINE).toBe(0.75);
    expect(resolveWorkdayScrapeTimeBudget({})).toEqual({
      budgetMs: 90_000,
      configuredMs: 90_000,
      cappedByDeadlineMs: null,
    });
  });

  it('caps the budget at 3/4 of a lower fan-out deadline, from either name', () => {
    expect(resolveWorkdayScrapeTimeBudget({ [FANOUT_DEADLINE_ENV_VAR]: '60000' })).toEqual({
      budgetMs: 45_000,
      configuredMs: 90_000,
      cappedByDeadlineMs: 60_000,
    });
    expect(resolveWorkdayScrapeTimeBudget({ [LEGACY_FANOUT_DEADLINE_ENV_VAR]: '60000' }).budgetMs).toBe(45_000);
    expect(
      resolveWorkdayScrapeTimeBudget({ [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: '300000' }).budgetMs,
    ).toBe(90_000);
  });

  it('leaves a budget already below the cap, or a raised deadline, alone', () => {
    expect(
      resolveWorkdayScrapeTimeBudget({ [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: '30000', [FANOUT_DEADLINE_ENV_VAR]: '60000' }),
    ).toEqual({ budgetMs: 30_000, configuredMs: 30_000, cappedByDeadlineMs: null });
    expect(
      resolveWorkdayScrapeTimeBudget({ [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: '300000', [FANOUT_DEADLINE_ENV_VAR]: '600000' }),
    ).toEqual({ budgetMs: 300_000, configuredMs: 300_000, cappedByDeadlineMs: null });
  });

  it('applies no cap when the fan-out deadline is off, and none to a budget that is off', () => {
    expect(
      resolveWorkdayScrapeTimeBudget({ [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: '300000', [FANOUT_DEADLINE_ENV_VAR]: '0' }),
    ).toEqual({ budgetMs: 300_000, configuredMs: 300_000, cappedByDeadlineMs: null });
    expect(
      resolveWorkdayScrapeTimeBudget({ [WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR]: '0', [FANOUT_DEADLINE_ENV_VAR]: '60000' }),
    ).toEqual({ budgetMs: 0, configuredMs: 0, cappedByDeadlineMs: null });
  });

  it('never caps to 0, which would mean "no budget"', () => {
    expect(resolveWorkdayScrapeTimeBudget({ [FANOUT_DEADLINE_ENV_VAR]: '1' }).budgetMs).toBe(1);
  });
});

/**
 * Spec 1736 T17 — the date helpers in real host time zones. Jest hands a test
 * file a copy of `process.env`, so `process.env.TZ = …` cannot move this
 * process's zone; a plain Node child (ts-node) switches zone per run and
 * reports each zone's UTC offset as the control that the switch happened.
 */
describe('Workday dates in real host time zones (child process) — Spec 1736 T17', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..');
  const DRIVER = path.join(__dirname, 'support', 'workday-dates-in-time-zones.ts');

  /** Zone and its `getTimezoneOffset()` on 2026-09-26 (minutes; positive = behind UTC). */
  const ZONES: Array<[string, number]> = [
    ['UTC', 0],
    ['America/Los_Angeles', 420],
    ['America/New_York', 240],
    ['Europe/Berlin', -120],
    ['Asia/Tokyo', -540],
    ['Pacific/Kiritimati', -840],
  ];

  /** Recorded Moderna rows (label, detail startDate) at 01:33 UTC on 2026-09-26. */
  const MODERNA = [
    { postedOn: 'Posted Today', startDate: '2026-09-25' },
    { postedOn: 'Posted Yesterday', startDate: '2026-09-24' },
    { postedOn: 'Posted 2 Days Ago', startDate: '2026-09-23' },
    { postedOn: 'Posted 3 Days Ago', startDate: '2026-09-22' },
  ];
  const LABELS = ['Posted Today', 'Posted Yesterday', 'Posted 2 Days Ago', 'Posted 3 Days Ago', 'Posted 30+ Days Ago'];
  const COUNTING_FROM_25TH = ['2026-09-25', '2026-09-24', '2026-09-23', '2026-09-22', null];
  const COUNTING_FROM_26TH = ['2026-09-26', '2026-09-25', '2026-09-24', '2026-09-23', null];

  const CASES = [
    // US Eastern board, a millisecond before and at UTC midnight: the 25th either way.
    { now: '2026-09-25T23:59:59.999Z', samples: MODERNA, labels: LABELS },
    { now: '2026-09-26T00:00:00.000Z', samples: MODERNA, labels: LABELS },
    // Undated board: the UTC date of `now`.
    { now: '2026-09-26T00:00:00.000Z', samples: [], labels: LABELS },
    // Tokyo board at 05:00 on the 26th (20:00 UTC on the 25th).
    { now: '2026-09-25T20:00:00.000Z', samples: [{ postedOn: 'Posted Today', startDate: '2026-09-26' }], labels: LABELS },
  ];
  const EXPECTED = [
    { board: '2026-09-25', offsetDays: 0, dates: COUNTING_FROM_25TH },
    { board: '2026-09-25', offsetDays: -1, dates: COUNTING_FROM_25TH },
    { board: null, offsetDays: null, dates: COUNTING_FROM_26TH },
    { board: '2026-09-26', offsetDays: 1, dates: COUNTING_FROM_26TH },
  ];

  it('gives the same board date and posted dates in six host time zones, UTC-7 to UTC+14', () => {
    const run = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', DRIVER],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.base.json'), TZ: 'UTC' },
        input: JSON.stringify({ zones: ZONES.map(([zone]) => zone), cases: CASES }),
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    expect(run.error).toBeUndefined();
    expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({ status: 0, stderr: '' });

    const results = JSON.parse(run.stdout) as TimeZoneResult[];
    // Control: every zone really took effect in the child.
    expect(results.map((result) => [result.zone, result.utcOffsetMinutes])).toEqual(ZONES);
    for (const result of results) {
      expect([result.zone, result.cases]).toEqual([result.zone, EXPECTED]);
    }
  }, 120_000);

  it('gives the same answers in this process as in the child', () => {
    const here = CASES.map((testCase) => {
      const now = new Date(testCase.now);
      const board = resolveWorkdayBoardToday(testCase.samples, now);
      return {
        board: board?.date ?? null,
        offsetDays: board?.offsetDays ?? null,
        dates: testCase.labels.map((label) => parseWorkdayPostedOn(label, board?.reference ?? now)),
      };
    });
    expect(here).toEqual(EXPECTED);
  });
});
