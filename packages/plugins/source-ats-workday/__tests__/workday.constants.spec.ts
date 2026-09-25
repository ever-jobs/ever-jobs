import {
  parseWorkdayPostedOn,
  parseWorkdaySlug,
  buildWorkdayUrl,
  buildWorkdayDetailUrl,
  WORKDAY_DETAIL_CONCURRENCY,
  WORKDAY_DETAIL_DELAY_MIN_MS,
  WORKDAY_DETAIL_DELAY_MAX_MS,
  workdaySearchText,
  workdayListingRequisitionId,
  readWorkdayMaxDetailFetches,
  readWorkdayScrapeTimeBudgetMs,
  DEFAULT_WORKDAY_MAX_DETAIL_FETCHES,
  DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS,
  WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR,
  WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR,
} from '../src/workday.constants';

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
    expect(workdayListingRequisitionId({ bulletFields: ['  R-2012345  '] })).toBe('R-2012345');
  });

  it('skips non-string bullets', () => {
    expect(workdayListingRequisitionId({ bulletFields: [42, null, 'R1'] as unknown[] })).toBe('R1');
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
