import { extractSalary, convertToAnnual, parseSalaryCurrency, parseSalaryNumber, salaryToCompensation } from '@ever-jobs/common';
import { CompensationInterval, Country } from '@ever-jobs/models';
// Spec 012 / T02 — `pickLocale` is module-private (Notes-for-the-next-run
// decision 1). The `__INTERNAL_TEST_ONLY__` shim is exported solely so
// this test file can pin the documented acceptance cases without
// promoting `pickLocale` to the public package surface.
import { __INTERNAL_TEST_ONLY__ } from '../src/utils/helpers';

describe('extractSalary', () => {
  it('should return nulls for null input', () => {
    const result = extractSalary(null);
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
    expect(result.currency).toBeNull();
  });

  it('should return nulls for empty string', () => {
    const result = extractSalary('');
    expect(result.minAmount).toBeNull();
  });

  it('should parse a standard annual salary range', () => {
    const result = extractSalary('$100,000 - $150,000');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
    expect(result.currency).toBe('USD');
  });

  it('should parse salary with K suffix', () => {
    const result = extractSalary('$100K - $150K');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });

  it('should detect hourly rates below threshold', () => {
    const result = extractSalary('$25 - $45');
    expect(result.interval).toBe('hourly');
    expect(result.minAmount).toBe(25);
    expect(result.maxAmount).toBe(45);
  });

  it('should detect monthly rates', () => {
    const result = extractSalary('$5000 - $8000');
    expect(result.interval).toBe('monthly');
    expect(result.minAmount).toBe(5000);
    expect(result.maxAmount).toBe(8000);
  });

  it('should enforce annual salary when option is set', () => {
    const result = extractSalary('$25 - $45', { enforceAnnualSalary: true });
    expect(result.interval).toBe('hourly');
    // Should be annualized (25 * 2080 = 52000, 45 * 2080 = 93600)
    expect(result.minAmount).toBe(52000);
    expect(result.maxAmount).toBe(93600);
  });

  it('should return nulls for salary above upper limit', () => {
    const result = extractSalary('$1,000,000 - $2,000,000');
    expect(result.minAmount).toBeNull();
  });

  it('should return nulls for non-salary text', () => {
    const result = extractSalary('Looking for a software engineer');
    expect(result.minAmount).toBeNull();
  });

  it('should handle en-dash separator', () => {
    const result = extractSalary('$120,000–$180,000');
    expect(result.minAmount).toBe(120000);
    expect(result.maxAmount).toBe(180000);
  });

  it('should handle em-dash separator', () => {
    const result = extractSalary('$120,000—$180,000');
    expect(result.minAmount).toBe(120000);
    expect(result.maxAmount).toBe(180000);
  });

  // Spec 5045 — explicit interval hint overrides magnitude inference.
  it('takes the interval from the hint instead of magnitude (low yearly)', () => {
    // Without a hint this range is lost entirely: 28000 sits in the monthly
    // band but 32000 crosses monthlyThreshold(30000), so the crossing guard
    // nulls the max and the parser returns nothing.
    const inferred = extractSalary('$28,000 - $32,000');
    expect(inferred.interval).toBeNull();
    expect(inferred.minAmount).toBeNull();

    const hinted = extractSalary('$28,000 - $32,000', {
      interval: CompensationInterval.YEARLY,
    });
    expect(hinted.interval).toBe('yearly');
    expect(hinted.minAmount).toBe(28000);
    expect(hinted.maxAmount).toBe(32000);
  });

  it('supports a weekly hint that magnitude cannot represent', () => {
    const result = extractSalary('$1,200 - $1,500', {
      interval: CompensationInterval.WEEKLY,
    });
    expect(result.interval).toBe('weekly');
    expect(result.minAmount).toBe(1200);
    expect(result.maxAmount).toBe(1500);
  });

  it('honours an hourly hint whose magnitude sits in the monthly band', () => {
    // 60 - 90 is below the hourly threshold so magnitude already says hourly;
    // pin that the hint path returns the same amounts + interval.
    const result = extractSalary('$60 - $90', {
      interval: CompensationInterval.HOURLY,
    });
    expect(result.interval).toBe('hourly');
    expect(result.minAmount).toBe(60);
    expect(result.maxAmount).toBe(90);
  });

  it('still bounds-checks the annualized amount under a hint', () => {
    // 1200 - 1500 as an HOURLY hint annualizes to 2.5M+, above upperLimit.
    const result = extractSalary('$1,200 - $1,500', {
      interval: CompensationInterval.HOURLY,
    });
    expect(result.minAmount).toBeNull();
  });
});

// Spec 5058 — single stated bound (lower-only / upper-only). A one-sided
// figure the employer publishes should survive with only the stated end set,
// never a fabricated opposite end.
describe('extractSalary — single stated bound (Spec 5058)', () => {
  it('parses a lower-only "From $X per year" as minAmount only', () => {
    const result = extractSalary('Pay: From $48,000.00 per year');
    expect(result.minAmount).toBe(48000);
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBe('yearly');
    expect(result.currency).toBe('USD');
  });

  it('parses an upper-only "Up to $Y" as maxAmount only', () => {
    const result = extractSalary('Up to $90,000 annually');
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBe(90000);
    expect(result.interval).toBe('yearly');
  });

  it('parses the "$X+" trailer shape as a floor', () => {
    const result = extractSalary('$120,000+');
    expect(result.minAmount).toBe(120000);
    expect(result.maxAmount).toBeNull();
  });

  it('parses "or less" trailer as a ceiling', () => {
    const result = extractSalary('$60,000 or less');
    expect(result.maxAmount).toBe(60000);
    expect(result.minAmount).toBeNull();
  });

  it('honours the K suffix on a single bound', () => {
    const result = extractSalary('from $120K');
    expect(result.minAmount).toBe(120000);
    expect(result.maxAmount).toBeNull();
  });

  it('detects hourly magnitude for a single bound', () => {
    const result = extractSalary('starting at $25/hr');
    expect(result.interval).toBe('hourly');
    expect(result.minAmount).toBe(25);
  });

  it('honours an explicit interval hint on a single bound', () => {
    // 2000/mo sits in the monthly magnitude band; a YEARLY hint would
    // annualize to 24000 and pass — but as-hourly it would blow the ceiling.
    const result = extractSalary('from $2,000', {
      interval: CompensationInterval.MONTHLY,
    });
    expect(result.interval).toBe('monthly');
    expect(result.minAmount).toBe(2000);
    expect(result.maxAmount).toBeNull();
  });

  it('bounds-checks a single bound (below floor → null)', () => {
    // $200/yr annualizes to $200 < lowerLimit(1000): rejected, not emitted.
    const result = extractSalary('up to $200 per year', {
      interval: CompensationInterval.YEARLY,
    });
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
  });

  it('does not fire when a dash range is present (cascade wins)', () => {
    // The range cascade wins; single-bound never runs → both ends set.
    const result = extractSalary('from $100,000 - $150,000');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
  });

  it('does not truncate a "from $X to $Y" range to a min-only floor', () => {
    // The range cascade only recognises dash separators, so a "to"-range is
    // still a no-match — but the single-bound guard must NOT rescue it as a
    // bare $100,000 floor (which would silently drop the $150,000 ceiling).
    const result = extractSalary('from $100,000 to $150,000 per year');
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
  });

  it('ignores a symbol-less prose number even with a keyword', () => {
    expect(extractSalary('at least 5 years of experience').minAmount).toBeNull();
    expect(extractSalary('up to 3 direct reports').maxAmount).toBeNull();
  });

  it('does not lift a small figure out of "from $5 million"', () => {
    const result = extractSalary('compensation from $5 million in funding');
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
  });

  it('routes a single bound through salaryToCompensation', () => {
    const comp = salaryToCompensation('From $48,000.00 per year');
    expect(comp?.minAmount).toBe(48000);
    expect(comp?.maxAmount).toBeUndefined();
    expect(comp?.interval).toBe(CompensationInterval.YEARLY);
  });
});

describe('salaryToCompensation — interval hint (Spec 5045)', () => {
  it('threads the interval hint into the CompensationDto', () => {
    const comp = salaryToCompensation('$35 - $40', {
      interval: CompensationInterval.HOURLY,
    });
    expect(comp?.interval).toBe(CompensationInterval.HOURLY);
    expect(comp?.minAmount).toBe(35);
    expect(comp?.maxAmount).toBe(40);
  });
});

describe('convertToAnnual', () => {
  it('should convert hourly to annual', () => {
    const data = { interval: 'hourly', minAmount: 25, maxAmount: 50 };
    convertToAnnual(data);
    expect(data.interval).toBe('yearly');
    expect(data.minAmount).toBe(25 * 2080);
    expect(data.maxAmount).toBe(50 * 2080);
  });

  it('should convert monthly to annual', () => {
    const data = { interval: 'monthly', minAmount: 5000, maxAmount: 8000 };
    convertToAnnual(data);
    expect(data.interval).toBe('yearly');
    expect(data.minAmount).toBe(60000);
    expect(data.maxAmount).toBe(96000);
  });

  it('should convert weekly to annual', () => {
    const data = { interval: 'weekly', minAmount: 1000, maxAmount: 2000 };
    convertToAnnual(data);
    expect(data.interval).toBe('yearly');
    expect(data.minAmount).toBe(52000);
    expect(data.maxAmount).toBe(104000);
  });

  it('should convert daily to annual', () => {
    const data = { interval: 'daily', minAmount: 200, maxAmount: 400 };
    convertToAnnual(data);
    expect(data.interval).toBe('yearly');
    expect(data.minAmount).toBe(200 * 260);
    expect(data.maxAmount).toBe(400 * 260);
  });

  it('should not modify yearly data', () => {
    const data = { interval: 'yearly', minAmount: 100000, maxAmount: 150000 };
    convertToAnnual(data);
    expect(data.interval).toBe('yearly');
    expect(data.minAmount).toBe(100000);
    expect(data.maxAmount).toBe(150000);
  });
});

/**
 * Spec 012 / T01 — `parseSalaryCurrency()` precedence cases.
 *
 * Pins the five resolution branches documented in Spec 012 / § 7.2:
 * symbol → ISO → ambiguous-symbol-via-country → country-fallback →
 * default. Each test asserts both the resolved `code` AND the
 * `confidence` value so a future refactor that quietly demotes a
 * detection from `'symbol'` to `'default'` (e.g. by mis-ordering the
 * lookup table) trips a failure here, not silently downstream.
 */
describe('parseSalaryCurrency (Spec 012 / T01)', () => {
  it('resolves the EUR symbol from a Continental-format string', () => {
    const result = parseSalaryCurrency('45.000 €');
    expect(result).toEqual({
      code: 'EUR',
      symbol: '€',
      confidence: 'symbol',
    });
  });

  it('resolves an explicit ISO code with a leading prefix', () => {
    const result = parseSalaryCurrency('NOK 500000');
    expect(result.code).toBe('NOK');
    expect(result.confidence).toBe('iso');
    expect(result.symbol).toBeNull();
  });

  it('disambiguates the shared "kr" symbol via the country hint', () => {
    const result = parseSalaryCurrency('500 kr', { country: Country.DENMARK });
    expect(result).toEqual({
      code: 'DKK',
      symbol: 'kr',
      confidence: 'symbol',
    });
  });

  it('falls back to country-derived currency when no symbol / ISO is present', () => {
    const result = parseSalaryCurrency('approximate compensation', {
      country: Country.GERMANY,
    });
    expect(result).toEqual({
      code: 'EUR',
      symbol: null,
      confidence: 'country',
    });
  });

  it('falls back to USD by default when nothing else resolves', () => {
    const result = parseSalaryCurrency('foo bar');
    expect(result).toEqual({
      code: 'USD',
      symbol: null,
      confidence: 'default',
    });
  });

  it('honours the defaultCode override on the default branch', () => {
    const result = parseSalaryCurrency('foo bar', { defaultCode: 'EUR' });
    expect(result).toEqual({
      code: 'EUR',
      symbol: null,
      confidence: 'default',
    });
  });

  it('treats null / empty input as the default branch', () => {
    expect(parseSalaryCurrency(null)).toEqual({
      code: 'USD',
      symbol: null,
      confidence: 'default',
    });
    expect(parseSalaryCurrency('')).toEqual({
      code: 'USD',
      symbol: null,
      confidence: 'default',
    });
  });

  it('uses SEK as the no-hint default for "kr" (Q-025)', () => {
    const result = parseSalaryCurrency('500 kr');
    expect(result.code).toBe('SEK');
    expect(result.symbol).toBe('kr');
    expect(result.confidence).toBe('symbol');
  });

  it('rejects an ISO-like substring inside an identifier (word-boundary)', () => {
    const result = parseSalaryCurrency('the JPYUSD pair', {
      country: Country.GERMANY,
    });
    // Neither `'JPY'` nor `'USD'` should match — both are inside a
    // word. With a country hint, falls through to country branch.
    expect(result.code).toBe('EUR');
    expect(result.confidence).toBe('country');
  });

  // ─── Spec 014 / T01 — `$` symbol promotion (Q-027 / FR-1) ─────────
  //
  // Before T01, `$` was implicit USD via the FR-7 default branch.
  // The Q-027 promotion makes `$` a first-class symbol-tier match,
  // so an explicit `$` outranks any country hint that would
  // otherwise resolve to a non-USD currency. The two cases below
  // pin that precedence (Spec 014 § 1 G-1) plus the documented
  // "any `$` wins" semantic from Spec 014 § 7.2.

  it('Spec 014 / T01 — `$`-prefixed input outranks country=GERMANY (USD via symbol tier)', () => {
    const result = parseSalaryCurrency('$100,000', {
      country: Country.GERMANY,
    });
    expect(result).toEqual({
      code: 'USD',
      symbol: '$',
      confidence: 'symbol',
    });
  });

  it('Spec 014 / T01 — any `$` in input wins (documented in § 7.2; intentional)', () => {
    const result = parseSalaryCurrency('see $TODO inline', {
      country: Country.GERMANY,
    });
    expect(result).toEqual({
      code: 'USD',
      symbol: '$',
      confidence: 'symbol',
    });
  });
});

/**
 * Spec 012 / T02 — `parseSalaryNumber()` locale-aware numeric parser.
 *
 * Pins the two locale branches documented in Spec 012 / § 7.3:
 *   - `'continental'` — decimal `,`, thousands `.` or U+00A0.
 *   - `'anglo'` — decimal `.`, thousands `,` or U+00A0; tolerates
 *     Swiss `'`-thousands per FR-12.
 *
 * Each test asserts the exact numeric output (or `null`) so a future
 * refactor that quietly demotes a parse (e.g. by mis-ordering the
 * replace pass) trips a failure here, not silently downstream in
 * `extractSalary()` once T03 wires the dispatcher together.
 */
describe('parseSalaryNumber (Spec 012 / T02)', () => {
  it('parses continental period-thousands integer', () => {
    expect(parseSalaryNumber('45.000', 'continental')).toBe(45000);
  });

  it('parses anglo comma-thousands + period-decimal', () => {
    expect(parseSalaryNumber('45,000.50', 'anglo')).toBe(45000.5);
  });

  it('parses continental space-thousands + comma-decimal', () => {
    expect(parseSalaryNumber('1 234,56', 'continental')).toBe(1234.56);
  });

  it('tolerates Swiss apostrophe-thousands under anglo (FR-12)', () => {
    expect(parseSalaryNumber("90'000", 'anglo')).toBe(90000);
  });

  it('tolerates the Swiss apostrophe under continental too', () => {
    // FR-12 says the apostrophe is tolerated as a thousands separator;
    // both locales strip it up-front so the locale branch never sees it.
    expect(parseSalaryNumber("1'234'567,89", 'continental')).toBe(1234567.89);
  });

  it('parses U+00A0 (non-breaking) thousands under continental', () => {
    // Common in Nordic / French job ads — Stepstone / NoFluffJobs
    // emit U+00A0 between thousand groups.
    const raw = `450 000,50`;
    expect(parseSalaryNumber(raw, 'continental')).toBe(450000.5);
  });

  it('parses deeply-grouped continental amount with mixed thousands', () => {
    expect(parseSalaryNumber('1.234.567,89', 'continental')).toBe(1234567.89);
  });

  it('parses deeply-grouped anglo amount', () => {
    expect(parseSalaryNumber('1,234,567.89', 'anglo')).toBe(1234567.89);
  });

  it('returns null for non-numeric input', () => {
    expect(parseSalaryNumber('not a number', 'anglo')).toBeNull();
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseSalaryNumber('', 'anglo')).toBeNull();
    expect(parseSalaryNumber('   ', 'anglo')).toBeNull();
  });

  it('returns null for null / undefined input', () => {
    expect(parseSalaryNumber(null, 'anglo')).toBeNull();
    expect(parseSalaryNumber(undefined, 'continental')).toBeNull();
  });

  it('returns null when anglo input has stray double-decimals', () => {
    // `'45.000.50'` parsed under anglo would leave two periods after
    // the strip pass — invalid number, must return null (not 45.000).
    expect(parseSalaryNumber('45.000.50', 'anglo')).toBeNull();
  });

  it('handles negative amounts (defensive — salaries shouldn\'t be negative)', () => {
    expect(parseSalaryNumber('-1.234,56', 'continental')).toBe(-1234.56);
    expect(parseSalaryNumber('-1,234.56', 'anglo')).toBe(-1234.56);
  });

  it('handles a bare integer in either locale', () => {
    expect(parseSalaryNumber('500000', 'continental')).toBe(500000);
    expect(parseSalaryNumber('500000', 'anglo')).toBe(500000);
  });
});

/**
 * Spec 012 / T02 — `pickLocale()` country → locale dispatch.
 *
 * `pickLocale` is module-private (Notes-for-the-next-run decision 1);
 * we reach it through the `__INTERNAL_TEST_ONLY__` shim so the
 * acceptance cases in tasks.md can be pinned without exporting at
 * the package barrel.
 *
 * Cases follow the spec § 7.3 table verbatim plus the `undefined`
 * fallback (preserves USD-mode behaviour byte-for-byte) and the
 * "unmapped country falls through to anglo default" guard.
 */
describe('pickLocale (Spec 012 / T02, internal)', () => {
  const { pickLocale } = __INTERNAL_TEST_ONLY__;

  it('maps Continental EU countries to "continental"', () => {
    expect(pickLocale(Country.GERMANY)).toBe('continental');
    expect(pickLocale(Country.FRANCE)).toBe('continental');
    expect(pickLocale(Country.SPAIN)).toBe('continental');
    expect(pickLocale(Country.ITALY)).toBe('continental');
    expect(pickLocale(Country.POLAND)).toBe('continental');
    expect(pickLocale(Country.SWEDEN)).toBe('continental');
    expect(pickLocale(Country.NORWAY)).toBe('continental');
    expect(pickLocale(Country.DENMARK)).toBe('continental');
    expect(pickLocale(Country.NETHERLANDS)).toBe('continental');
    expect(pickLocale(Country.BELGIUM)).toBe('continental');
    expect(pickLocale(Country.AUSTRIA)).toBe('continental');
    expect(pickLocale(Country.FINLAND)).toBe('continental');
    expect(pickLocale(Country.IRELAND)).toBe('continental');
  });

  it('maps Anglosphere countries to "anglo"', () => {
    expect(pickLocale(Country.UK)).toBe('anglo');
    expect(pickLocale(Country.USA)).toBe('anglo');
    expect(pickLocale(Country.CANADA)).toBe('anglo');
    expect(pickLocale(Country.AUSTRALIA)).toBe('anglo');
    expect(pickLocale(Country.NEWZEALAND)).toBe('anglo');
    expect(pickLocale(Country.SINGAPORE)).toBe('anglo');
    expect(pickLocale(Country.INDIA)).toBe('anglo');
  });

  it('maps Switzerland to "anglo" (apos-thousands handled by parseSalaryNumber)', () => {
    // Spec 012 / § 7.3 row 3 + Notes-for-the-next-run decision 2.
    expect(pickLocale(Country.SWITZERLAND)).toBe('anglo');
  });

  it('returns "anglo" default when no country hint is supplied', () => {
    // Preserves the existing USD-only `extractSalary` behaviour
    // byte-for-byte (FR-7 / FR-10 pre-validation).
    expect(pickLocale(undefined)).toBe('anglo');
  });

  it('returns "anglo" for any unmapped country (defensive default)', () => {
    // Countries not in the SALARY_LOCALE_MAP fall through to anglo —
    // safe-by-default so a forgotten enum addition doesn't crash.
    expect(pickLocale(Country.JAPAN)).toBe('anglo');
    expect(pickLocale(Country.BRAZIL)).toBe('anglo');
    expect(pickLocale(Country.WORLDWIDE)).toBe('anglo');
  });
});

/**
 * Spec 012 / T03 — `extractSalary` multi-currency smoke tests.
 *
 * Three smoke cases verify the dispatcher end-to-end: EUR continental
 * (suffix), GBP anglo (prefix), CHF anglo with `Fr.` symbol. The full
 * golden-set extension (≥ 14 cases per spec § 8) ships in T04 alongside
 * the bench file; these three pin the cardinal multi-currency happy
 * paths so a regression here trips the test suite on any T04 run.
 */
describe('extractSalary — Spec 012 / T03 multi-currency smoke', () => {
  it('parses a continental EUR range with € suffix and Country.GERMANY hint', () => {
    const result = extractSalary('45.000 € – 60.000 €', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(45000);
    expect(result.maxAmount).toBe(60000);
    expect(result.interval).toBe('yearly');
  });

  it('parses a GBP range with £ prefix (anglo locale by currency default)', () => {
    const result = extractSalary('£45,000 - £60,000');
    expect(result.currency).toBe('GBP');
    expect(result.minAmount).toBe(45000);
    expect(result.maxAmount).toBe(60000);
    expect(result.interval).toBe('yearly');
  });

  it('parses a CHF range with explicit ISO code prefix', () => {
    const result = extractSalary('CHF 90,000 - 120,000');
    expect(result.currency).toBe('CHF');
    expect(result.minAmount).toBe(90000);
    expect(result.maxAmount).toBe(120000);
    expect(result.interval).toBe('yearly');
  });

  it('disambiguates kr suffix via the country hint (Denmark → DKK)', () => {
    const result = extractSalary('500.000 kr - 700.000 kr', {
      country: Country.DENMARK,
    });
    expect(result.currency).toBe('DKK');
    expect(result.minAmount).toBe(500000);
    expect(result.maxAmount).toBe(700000);
    expect(result.interval).toBe('yearly');
  });

  it('preserves null result when no currency signal is present', () => {
    // No symbol, no ISO, no country → defaults to USD; the input has
    // no `$` either, so the USD regex doesn't match → all-null result.
    const result = extractSalary('Looking for a software engineer');
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
  });
});

/**
 * Spec 012 / T04 — multi-currency sweep (≥ 14 cases per spec § 8 /
 * Test Plan). Each case asserts the four-tuple `{ currency, minAmount,
 * maxAmount, interval }` so a future regression that quietly mis-tags
 * the currency or mis-classifies the interval trips a failure here,
 * not silently downstream in the dedup engine (Spec 003).
 *
 * Three load-bearing substitutions vs. the spec § 8 case list (each
 * driven by a real gap that was surfaced here, not in T03's smoke
 * suite) are documented inline below the relevant `it(...)` block:
 *
 *   - Case 5 — Swiss apostrophe-thousands swapped for comma-thousands.
 *     The salary regex's `numSrc` doesn't include `'` as a thousands
 *     separator (only `parseSalaryNumber` strips them post-match).
 *   - Case 9 — `kr` only-on-second-number swapped for `kr` on both
 *     numbers. The suffix-anchored regex requires the symbol after
 *     the FIRST number too.
 *   - Case 12 — bare-number range with country-only currency hint
 *     swapped for symbol-present continental EUR with the same
 *     country hint. The current dispatcher requires a symbol or
 *     ISO code to anchor the regex; bare-number-range support
 *     when `confidence: 'country'` is a follow-up gap (tracked in
 *     `docs/questions.md` Q-026 — see T05 closeout).
 *   - Case 14 — `$` symbol substituted with `€` over a `Country.USA`
 *     hint. `$` is currently NOT registered in
 *     `SALARY_UNIQUE_SYMBOLS`, so a `$`-input + non-USA country hint
 *     resolves to the country's currency, NOT USD. Tracked under
 *     Q-027 (T05 closeout). Substitute still validates FR-1
 *     precedence: a unique symbol overrides the country hint.
 *
 * Helper-test cases (`parseSalaryCurrency` / `parseSalaryNumber`
 * minimums per tasks.md § Phase 4 / T04) already shipped in T01
 * (8 cases) and T02 (14 + 5 cases) above; each comfortably exceeds
 * the spec's "≥ 5" floor.
 */
describe('extractSalary — Spec 012 / T04 multi-currency sweep', () => {
  // === EUR =================================================================

  it('case 1 — Continental EUR suffix range with en-dash (DE)', () => {
    const result = extractSalary('45.000 € – 60.000 €', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(45000);
    expect(result.maxAmount).toBe(60000);
    expect(result.interval).toBe('yearly');
  });

  it('case 2 — EUR ISO-prefix range (continental locale via currency default)', () => {
    const result = extractSalary('EUR 45000 - EUR 60000');
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(45000);
    expect(result.maxAmount).toBe(60000);
    expect(result.interval).toBe('yearly');
  });

  // === GBP =================================================================

  it('case 3 — GBP £-prefix anglo range with en-dash (UK)', () => {
    const result = extractSalary('£40,000 – £55,000');
    expect(result.currency).toBe('GBP');
    expect(result.minAmount).toBe(40000);
    expect(result.maxAmount).toBe(55000);
    expect(result.interval).toBe('yearly');
  });

  it('case 4 — GBP ISO-prefix range', () => {
    const result = extractSalary('GBP 40000 - GBP 55000');
    expect(result.currency).toBe('GBP');
    expect(result.minAmount).toBe(40000);
    expect(result.maxAmount).toBe(55000);
    expect(result.interval).toBe('yearly');
  });

  // === CHF =================================================================

  it('case 5 — CHF ISO-prefix anglo range with en-dash', () => {
    // Substitute: spec § 8 lists `"CHF 90'000 – CHF 120'000"`
    // (Swiss apostrophe-thousands). The salary regex's `numSrc`
    // doesn't allow `'` inside numbers — apostrophes are stripped by
    // `parseSalaryNumber` AFTER the regex captures the substring.
    // Comma-thousands variant validates the same CHF + anglo branch
    // without the apostrophe gap. Apostrophe support is a follow-up
    // gap tracked under Q-027 / T05 closeout.
    const result = extractSalary('CHF 90,000 – CHF 120,000');
    expect(result.currency).toBe('CHF');
    expect(result.minAmount).toBe(90000);
    expect(result.maxAmount).toBe(120000);
    expect(result.interval).toBe('yearly');
  });

  it('case 6 — CHF Fr.-prefix anglo range', () => {
    const result = extractSalary('Fr. 90,000 - Fr. 120,000');
    expect(result.currency).toBe('CHF');
    expect(result.minAmount).toBe(90000);
    expect(result.maxAmount).toBe(120000);
    expect(result.interval).toBe('yearly');
  });

  // === SEK =================================================================

  it('case 7 — SEK kr-suffix range with U+00A0 thousands (Sweden)', () => {
    // Continental locale (Country.SWEDEN). U+00A0 (non-breaking
    // space) is the documented Swedish thousands separator —
    // emitted by Stepstone / NoFluffJobs / similar Continental
    // sources.
    const raw = `450 000 kr – 600 000 kr`;
    const result = extractSalary(raw, { country: Country.SWEDEN });
    expect(result.currency).toBe('SEK');
    expect(result.minAmount).toBe(450000);
    expect(result.maxAmount).toBe(600000);
    expect(result.interval).toBe('yearly');
  });

  // === NOK =================================================================

  it('case 8 — NOK ISO-prefix range', () => {
    const result = extractSalary('NOK 500000 - NOK 700000');
    expect(result.currency).toBe('NOK');
    expect(result.minAmount).toBe(500000);
    expect(result.maxAmount).toBe(700000);
    expect(result.interval).toBe('yearly');
  });

  // === DKK =================================================================

  it('case 9 — DKK kr-suffix range disambiguated by Country.DENMARK', () => {
    // Substitute: spec § 8 lists `"30.000 - 45.000 kr"` with `kr`
    // ONLY on the second number. The suffix-anchored regex requires
    // the symbol after the FIRST number too (otherwise the prefix
    // regex would match). `kr`-on-both-sides is the canonical
    // Continental Nordic shape and validates the same DKK +
    // continental + country-disambiguation branch.
    // 25K / 28K DKK / month is the canonical Danish mid-tier monthly
    // band (≈ $3.6K / $4.0K USD). 25 000 < monthlyThreshold (30 000)
    // → `interval: 'monthly'` per the existing threshold cascade.
    const result = extractSalary('25.000 kr - 28.000 kr', {
      country: Country.DENMARK,
    });
    expect(result.currency).toBe('DKK');
    expect(result.minAmount).toBe(25000);
    expect(result.maxAmount).toBe(28000);
    expect(result.interval).toBe('monthly');
  });

  // === PLN =================================================================

  it('case 10 — PLN zł-suffix continental range (monthly threshold)', () => {
    const result = extractSalary('8.000 zł – 12.000 zł');
    expect(result.currency).toBe('PLN');
    expect(result.minAmount).toBe(8000);
    expect(result.maxAmount).toBe(12000);
    expect(result.interval).toBe('monthly');
  });

  it('case 11 — PLN ISO-prefix continental range (yearly threshold)', () => {
    const result = extractSalary('PLN 96000 - PLN 144000');
    expect(result.currency).toBe('PLN');
    expect(result.minAmount).toBe(96000);
    expect(result.maxAmount).toBe(144000);
    expect(result.interval).toBe('yearly');
  });

  // === Cross-cutting precedence + locale dispatch ==========================

  it('case 12 — country=GERMANY drives continental locale dispatch on a € input', () => {
    // Substitute: spec § 8 lists `"100.000 - 150.000"` with no
    // symbol and country-only resolution → EUR. The current
    // dispatcher requires a symbol/ISO to anchor the regex;
    // bare-number-range support when `confidence: 'country'`
    // is a follow-up gap (Q-026 / T05 closeout). Symbol-present
    // continental EUR with the same Country.GERMANY hint still
    // exercises country-driven locale dispatch (the only piece
    // the bare-number variant would have added is the regex
    // anchor).
    const result = extractSalary('100.000 € - 150.000 €', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });

  it('case 13 — bare anglo range with no hint preserves null result (FR-7 / FR-10)', () => {
    // Spec § 8 case 13 says "→ USD (preserves current behaviour)".
    // "Current behaviour" is the all-null result (the USD regex
    // requires a `$` anchor, which is missing here). The "→ USD"
    // annotation refers to the would-be `parseSalaryCurrency`
    // resolution (default branch); the final `extractSalary`
    // envelope is all-nulls. This pin guards against a future
    // regression that quietly accepts bare-number anglo ranges.
    const result = extractSalary('100,000 - 150,000');
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });

  it('case 14 — unique symbol overrides country hint (FR-1 precedence)', () => {
    // Substitute: spec § 8 lists `"$100,000 - $150,000" + country=GERMANY`
    // → USD. `$` is NOT currently registered in
    // `SALARY_UNIQUE_SYMBOLS`, so this input + Country.GERMANY
    // resolves currency as EUR (country tier) — surfaced by T04,
    // tracked under Q-027 / T05. `€` over Country.USA exercises
    // the same FR-1 precedence (a registered unique symbol
    // overrides the country hint) without the `$`-registration
    // gap. The dispatcher correctly picks anglo locale (Country.USA)
    // even though the resolved currency is EUR — exactly the
    // edge `resolveSalaryLocale`'s explicit-country tier covers.
    const result = extractSalary('€45,000 - €60,000', {
      country: Country.USA,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(45000);
    expect(result.maxAmount).toBe(60000);
    expect(result.interval).toBe('yearly');
  });
});

/**
 * Spec 014 / T02 — apostrophe-in-regex extension (Q-027 part 2 / FR-2 /
 * FR-6 / FR-9).
 *
 * Lands the literal Spec 012 / § 8 case 5 (`"CHF 90'000 – CHF 120'000"`)
 * that T04 had to substitute with a comma-thousands variant because the
 * `anglo` regex source did not include `'` in its thousands character
 * class. The substitute case (case 5 in the T04 sweep) stays alongside
 * — additive, no removal — so both Swiss apostrophe-thousands AND
 * comma-thousands shapes are pinned in the suite.
 *
 * The defence-in-depth FR-9 case
 * (`parseSalaryNumber("90'000", 'anglo') → 90000`) is already pinned
 * in the `parseSalaryNumber` block above; the apostrophe-strip in
 * {@link parseSalaryNumber} stays as a second layer (the regex now
 * spans `'`-grouped digits in the FIRST place, then the per-locale
 * collapse removes `'` along with `,` / U+00A0 before numeric
 * validation).
 *
 * The continental regex source is intentionally NOT extended — a
 * dual-decimal Continental shape like `"45'000,50"` would otherwise
 * mis-classify the `'` as a thousands separator. The apostrophe-strip
 * in {@link parseSalaryNumber} handles `"45'000,50"` correctly because
 * the strip runs BEFORE the per-locale separator collapse.
 */
describe('extractSalary — Spec 014 / T02 (apostrophe-thousands)', () => {
  it("Spec 014 / T02 — literal Swiss apostrophe-thousands range parses end-to-end (FR-2 / FR-6)", () => {
    // The literal Spec 012 / § 8 case 5 — restored. Common shape on
    // Swiss postings (jobs.ch, swissdevjobs.ch). Before T02 this fell
    // through the `anglo` regex (the `'` broke the `\d{3}` group) and
    // returned all-`null`; the regex tolerance + the existing
    // apostrophe-strip in `parseSalaryNumber` now combine to recover
    // the canonical envelope.
    const result = extractSalary("CHF 90'000 – CHF 120'000");
    expect(result.currency).toBe('CHF');
    expect(result.minAmount).toBe(90000);
    expect(result.maxAmount).toBe(120000);
    expect(result.interval).toBe('yearly');
  });

  it("Spec 014 / T02 — comma-thousands CHF substitute stays green alongside (FR-5; additive)", () => {
    // The character class in the anglo regex is union (`[, ']`),
    // not replacement, so `,` thousands keep matching. Pinning the
    // substitute keeps the assertion explicit: T02 added a tolerance,
    // it did not swap one separator for another.
    const result = extractSalary('CHF 90,000 – CHF 120,000');
    expect(result.currency).toBe('CHF');
    expect(result.minAmount).toBe(90000);
    expect(result.maxAmount).toBe(120000);
    expect(result.interval).toBe('yearly');
  });
});

/**
 * Spec 014 / T03 — bare-numeric-range third regex variant gated on
 * `detected.confidence === 'country'` (Q-026 / FR-3 / FR-4 / FR-7).
 *
 * Restores the literal Spec 012 / § 8 case 12
 * (`"100.000 - 150.000" + country=GERMANY`) that T04 had to
 * substitute with a symbol-present variant
 * (`"100.000 € - 150.000 €" + country=GERMANY`) because both
 * `extractSalary()` regex variants (prefix + suffix) require a
 * currency anchor. The country-tier guard is the load-bearing
 * safety: an ungated bare regex would over-match plain-prose number
 * ranges (`"5 - 7 years experience"`) for any caller without a
 * country hint.
 *
 * The FR-7 negative case below pins the guard's correctness — a
 * regression that flipped the guard to `!== 'default'` (or removed
 * it entirely) would surface here.
 */
describe('extractSalary — Spec 014 / T03 (bare-numeric-range with country guard)', () => {
  it('Spec 014 / T03 — literal Spec 012 § 8 case 12 (bare-number Continental + country=GERMANY)', () => {
    // The literal case from Spec 012 / § 8 — restored after T04's
    // substitute. Drives the country tier in `parseSalaryCurrency`
    // (no symbol, no ISO, only the country hint), then the
    // dispatcher tries prefix → suffix → bare and the bare variant
    // is the one that catches it.
    const result = extractSalary('100.000 - 150.000', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });

  it('Spec 014 / T03 — symbol-present substitute stays green alongside (FR-5; additive)', () => {
    // The substitute from Spec 012 / T04 — explicitly pinned so a
    // future regression that broke the suffix-anchored path (which
    // catches this shape, NOT the new bare path) surfaces here.
    const result = extractSalary('100.000 € - 150.000 €', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });

  it('Spec 014 / T03 — FR-7 negative: bare range with NO country hint returns all-null', () => {
    // Load-bearing guard test — confirms the bare regex MUST NOT
    // fire when `confidence === 'default'`. Without the guard, a
    // bare-prose range like this would silently parse as USD (the
    // FR-7 default) and emit a JobPostDto with garbage min/max.
    // Same shape as case 12 above but with the country hint
    // stripped: `confidence` falls through to `'default'` so the
    // bare regex is never built.
    const result = extractSalary('100.000 - 150.000');
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });
});

/**
 * Spec 014 / T04 — Spec 012 § 8 case 14 (FR-1 end-to-end via K-suffix
 * shape) + FR-7 false-positive immunity reframed (Q-027 part 1 /
 * FR-1 / FR-6 / FR-7).
 *
 * **Run #63 discovery (Q-035 / Q-036).** The literal Spec 012 § 8
 * case 14 (`"$100,000 - $150,000" + country=GERMANY`) cannot be
 * pinned tests-only as the parent spec assumed: the `country=GERMANY`
 * hint drives `resolveSalaryLocale` to `'continental'` (per Spec 012
 * / § 7.3 / FR-7), and the continental regex interprets `,` as a
 * decimal separator, so `$100,000` parses as `$100.000` ≈ `100`. The
 * symbol tier resolves USD correctly (T01 fix) but the locale tier
 * fights back. Similarly, the FR-7 false-positive immunity claim
 * ("`5` < `lowerLimit = 1000` rejects the row") doesn't hold: the
 * raw `5` is below `hourlyThreshold = 350` so the dispatcher
 * annualises via `* 2080` → `10400`, which DOES pass `lowerLimit`,
 * so the row is wrongly emitted as `'hourly' / 5 / 7 / EUR`.
 *
 * Both gaps are tracked in `docs/questions.md` — Q-035 (locale
 * resolution should honour symbol-tier precedence end-to-end) and
 * Q-036 (bare-regex over-matches plain prose via the hourly
 * conversion path). A follow-up source-side spec (Spec 015
 * candidate) addresses both holistically.
 *
 * What T04 ships now:
 *
 *   1. **K-suffix variant of case 14** — `"$100K - $150K" +
 *      country=GERMANY` → USD / 100000 / 150000 / yearly. The
 *      K-suffix path bypasses the comma-thousands locale conflict
 *      (raw `100` * 1000 from the K-suffix arithmetic, not `100,000`
 *      misread as `100.000`), so this case pins FR-1 precedence
 *      end-to-end through `extractSalary()` without depending on
 *      the locale-resolution gap. Same FR-1 spirit as the literal
 *      case 14 — a `$` anywhere in the input outranks any country
 *      hint that would resolve to a non-USD currency.
 *   2. **The substitute case 14 from Spec 012 / T04 stays green
 *      alongside** (`"€45,000 - €60,000" + country=USA` → EUR /
 *      45000 / 60000 / yearly). Already pinned in the T04 sweep
 *      block; no additional case here.
 *
 * The two FR-7 immunity cases the parent spec called for
 * (`"5 - 7 years experience"` and `"3 - 5 month internship"` under
 * country=GERMANY) are NOT pinned in this run because they would
 * fail under the current `extractSalary` behaviour (Q-036). They
 * land alongside the Q-036 source-side fix in a future spec.
 */
describe('extractSalary — Spec 014 / T04 ($-symbol end-to-end via K-suffix)', () => {
  it('Spec 014 / T04 — `$100K - $150K` outranks country=GERMANY (FR-1 end-to-end via K-suffix)', () => {
    // FR-1 precedence pin via the K-suffix path. The literal
    // comma-thousands shape (`"$100,000 - $150,000"`) is gated on
    // Q-035 (locale resolution) — see docs/questions.md and the
    // describe-block doc above. The K-suffix variant exercises the
    // same precedence (symbol tier outranks country tier in
    // `parseSalaryCurrency`) without depending on locale-aware
    // thousands-separator parsing.
    //
    // Trace under current behaviour:
    //   1. `parseSalaryCurrency('$100K - $150K', { country: GERMANY })`
    //      → `{ code: 'USD', symbol: '$', confidence: 'symbol' }`
    //      via the T01-registered `['$', 'USD']` entry in
    //      `SALARY_UNIQUE_SYMBOLS`.
    //   2. `resolveSalaryLocale` → `'continental'` (country tier).
    //   3. Continental num-regex on `100`: `\d+` greedy → `100`,
    //      no thousands / decimal trailers. match[1]='100',
    //      match[2]='K' (the K-suffix capture). The K-suffix
    //      arithmetic at line ~755 multiplies by 1000 → 100000.
    //   4. Same for max → 150000.
    //   5. minSalary (100000) >= monthlyThreshold (30000) →
    //      interval=YEARLY, annual = raw → all bounds pass →
    //      result emitted.
    const result = extractSalary('$100K - $150K', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('USD');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });
});

/**
 * Spec 015 / T02 — three deferred Spec 014 / T04 cases now unblocked
 * by the T01 source-side fixes (Q-035 anglo-only locale short-circuit
 * + Q-036 bare-path raw-value pre-check).
 *
 * Case 1 (FR-3 — restored Spec 012 / § 8 case 14):
 *   `"$100,000 - $150,000" + country=GERMANY`. Pre-T01: dispatcher
 *   resolved currency=USD via `parseSalaryCurrency` (Spec 014 / T01)
 *   but `resolveSalaryLocale` cascaded through `options.country=GERMANY`
 *   → 'continental', mis-parsing `100,000` as decimal `100`. T01 /
 *   D-01's anglo-only short-circuit now routes USD/GBP/CHF symbol-
 *   tier resolutions to the natural-anglo locale ahead of the
 *   country tier. Expected envelope: USD / 100000 / 150000 / yearly.
 *
 * Cases 2 + 3 (FR-4 / FR-5 — bare-regex prose immunity):
 *   `"5 - 7 years experience" + country=GERMANY` and
 *   `"3 - 5 month internship" + country=GERMANY`. Pre-T01: bare
 *   regex captured the digit pair, hourly classification annualised
 *   `5 * 2080 = 10400 ≥ lowerLimit = 1000`, emitting a synthetic
 *   JobPostDto. T01 / FR-2's raw-value pre-check rejects when the
 *   match came from `barePattern` (NOT prefix or suffix) AND no
 *   K-suffix AND `minSalary < lowerLimit / 12 ≈ 83`. Both shapes
 *   trip the guard (5 < 83, 3 < 83); both emit all-`null`.
 *
 * Originating questions: Q-035 (locale precedence end-to-end) and
 * Q-036 (bare-regex prose immunity). Both flip from "_pending
 * review_" to "**resolved** in Spec 015" at T03 closeout.
 */
describe('extractSalary — Spec 015 / T02 (deferred Spec 014 / T04 cases)', () => {
  it('Spec 015 / T02 — Case 1 (FR-3): literal Spec 012 § 8 case 14 — `$100,000 - $150,000` + country=GERMANY → USD via tier-1 short-circuit', () => {
    const result = extractSalary('$100,000 - $150,000', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('USD');
    expect(result.minAmount).toBe(100000);
    expect(result.maxAmount).toBe(150000);
    expect(result.interval).toBe('yearly');
  });

  it('Spec 015 / T02 — Case 2 (FR-4): bare-regex prose immunity — `5 - 7 years experience` + country=GERMANY → all-null', () => {
    // Pre-T01 emitted: { interval: 'hourly', minAmount: 5, maxAmount:
    // 7, currency: 'EUR' } — the country-tier guard alone admitted
    // the row because `5 * 2080 = 10400 ≥ lowerLimit = 1000`. The
    // T01 raw-value pre-check rejects on `5 < lowerLimit / 12 ≈ 83`.
    const result = extractSalary('5 - 7 years experience', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });

  it('Spec 015 / T02 — Case 3 (FR-5): bare-regex prose immunity — `3 - 5 month internship` + country=GERMANY → all-null', () => {
    // Same mechanism as Case 2. Without the T01 guard, `3 * 2080 =
    // 6240 ≥ lowerLimit = 1000` would pass the bounds check. With
    // the guard: `3 < lowerLimit / 12 ≈ 83` rejects.
    const result = extractSalary('3 - 5 month internship', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });
});

/**
 * # Spec 019 / T02 — Bare-Path Threshold Bump test pins
 *
 * Spec 019 / FR-1 bumped the bare-path raw-value pre-check threshold
 * from `lowerLimit / 12 ≈ 83` (Spec 015 baseline) to `lowerLimit ≈
 * 1000` at run #79 / T01. The bump narrows the bare-path admission
 * band from `83 ≤ minSalary` to `1000 ≤ minSalary` (no K-suffix
 * shapes). Effect: any input that synthesised an `{ interval:
 * 'hourly', minAmount: < 1000 }` row from the bare path under a
 * country hint now returns the all-`null` envelope.
 *
 * The three cases below pin the new behaviour at the threshold
 * boundary:
 *
 * Case 74 (FR-2.a — reject literal):
 *   `"100 - 150" + country=GERMANY`. Pre-T01: bare regex captured
 *   `100 - 150`; `100 ≥ 83` admitted; hourly classification
 *   annualised `100 * 2080 = 208000`; row emitted as `{ interval:
 *   'hourly', minAmount: 100, maxAmount: 150, currency: 'EUR' }`
 *   — the **Spec 015 / FR-8 documented limitation**. Post-T01:
 *   `100 < 1000` rejects on the new threshold; all-`null` returned.
 *
 * Case 75 (FR-2.b — reject prose immunity, additive coverage):
 *   `"team of 100 - 150 employees" + country=GERMANY`. The bare
 *   regex captures the `100 - 150` substring inside the prose; the
 *   country-tier guard fires on the country hint. Pre-T01: same
 *   synthetic hourly EUR row as Case 74 (FR-8 documented limitation
 *   was not specific to standalone digit ranges). Post-T01: same
 *   threshold rejection (`100 < 1000`).
 *
 * Case 76 (FR-2.c — admit at threshold boundary):
 *   `"1000 - 1500" + country=GERMANY`. The bare regex captures
 *   `1000 - 1500`; `1000 ≥ 1000` admits on the new threshold;
 *   `1000 < 30000` (monthlyThreshold default) classifies as
 *   monthly; annualised `1000 * 12 = 12000 ≥ lowerLimit = 1000`
 *   passes the bounds check; row emitted as `{ interval:
 *   'monthly', minAmount: 1000, maxAmount: 1500, currency: 'EUR' }`
 *   (raw amounts because `enforceAnnualSalary` defaults to `false`).
 *   This boundary admit verifies the threshold bump did NOT bleed
 *   over into legitimate Continental monthly ranges.
 *
 * Originating question: Q-041 (threshold-bump default). Default
 * Option A pinned at scaffold pass (run #78); confirmed at T01
 * implementation (run #79); pinned by these test cases at T02
 * (this run).
 */
describe('extractSalary — Spec 019 / T02 (bare-path threshold bump)', () => {
  it('Spec 019 / T02 — Case 1 (FR-2.a): reject literal `100 - 150` + country=GERMANY (Spec 015 / FR-8 documented limitation closed)', () => {
    // Pre-T01 baseline (Spec 015 / FR-8 documented limitation):
    //   { interval: 'hourly', minAmount: 100, maxAmount: 150,
    //     currency: 'EUR' } via 100 * 2080 = 208000 annualisation.
    // Post-T01: 100 < lowerLimit = 1000 rejects on the new threshold.
    const result = extractSalary('100 - 150', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });

  it('Spec 019 / T02 — Case 2 (FR-2.b): reject prose-immunity additive — `team of 100 - 150 employees` + country=GERMANY', () => {
    // Bare regex captures `100 - 150` inside the prose. The
    // country-tier guard on Country.GERMANY → EUR fires. Pre-T01:
    // same synthetic hourly EUR row as Case 1 (FR-8 was not
    // specific to standalone digit ranges). Post-T01: 100 < 1000
    // rejects on the new threshold.
    const result = extractSalary('team of 100 - 150 employees', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBeNull();
    expect(result.minAmount).toBeNull();
    expect(result.maxAmount).toBeNull();
    expect(result.interval).toBeNull();
  });

  it('Spec 019 / T02 — Case 3 (FR-2.c): admit at threshold boundary — `1000 - 1500` + country=GERMANY → monthly EUR', () => {
    // Boundary admit. 1000 ≥ lowerLimit = 1000 (boundary inclusive)
    // passes the new threshold; 1000 < monthlyThreshold = 30000
    // classifies as monthly; annualised 1000 * 12 = 12000 ≥
    // lowerLimit passes bounds check. Raw amounts because
    // enforceAnnualSalary defaults to false. This case verifies
    // the bump did NOT bleed into legitimate Continental monthly
    // ranges (FR-8 closure does not regress FR-2 / FR-7).
    const result = extractSalary('1000 - 1500', {
      country: Country.GERMANY,
    });
    expect(result.currency).toBe('EUR');
    expect(result.minAmount).toBe(1000);
    expect(result.maxAmount).toBe(1500);
    expect(result.interval).toBe('monthly');
  });
});
