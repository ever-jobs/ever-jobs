import {
  parseWorkdayPostedOn,
  parseWorkdaySlug,
  buildWorkdayUrl,
  buildWorkdayDetailUrl,
  WORKDAY_DETAIL_CONCURRENCY,
  WORKDAY_DETAIL_DELAY_MIN_MS,
  WORKDAY_DETAIL_DELAY_MAX_MS,
  workdaySearchText,
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
