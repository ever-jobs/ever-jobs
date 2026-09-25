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
  hasWorkdayLocationShape,
  splitWorkdayAdditionalLocations,
  workdayListingLocationLabel,
  workdayImpliedCountryCode,
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
