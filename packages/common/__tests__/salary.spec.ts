/**
 * Spec 1695 — salary parsing hardening.
 *
 * Pins the shared salary helpers end to end: null-safe `parseCurrency`,
 * partial-bound `convertToAnnual`, pay-period tokens and the `to` separator in
 * `extractSalary`, the post-scrape rule in `postProcessCompensation`, and the
 * `legacy` grammar that keeps the earlier behaviour reachable (per call or via
 * `EVER_JOBS_SALARY_GRAMMAR`). Every input is synthetic or a short salary field
 * value of the kind public job feeds publish.
 */
import {
  convertToAnnual,
  extractSalary,
  hasSalaryAmount,
  intervalFromPeriodToken,
  parseCurrency,
  postProcessCompensation,
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  CompensationDto,
  CompensationInterval,
  Country,
  SalarySource,
} from '@ever-jobs/models';

const GRAMMAR_ENV = 'EVER_JOBS_SALARY_GRAMMAR';

// Every case runs against the default grammar, whatever the shell exports;
// the suites that test the switch set it themselves.
const shellGrammar = process.env[GRAMMAR_ENV];
beforeEach(() => {
  delete process.env[GRAMMAR_ENV];
});
afterAll(() => {
  if (shellGrammar === undefined) delete process.env[GRAMMAR_ENV];
  else process.env[GRAMMAR_ENV] = shellGrammar;
});

/** Compact rendering of an `extractSalary` envelope for table-driven asserts. */
function render(result: ReturnType<typeof extractSalary>): string {
  if (result.minAmount == null && result.maxAmount == null) return 'null';
  return `${result.interval} ${result.minAmount}-${result.maxAmount} ${result.currency}`;
}

describe('parseCurrency — null-safe (Spec 1695)', () => {
  it.each(['Negotiable', '', '-', 'Competitive salary', '   '])(
    'returns null, never NaN, for %p',
    (text) => {
      expect(parseCurrency(text)).toBeNull();
    },
  );

  it('returns null for null / undefined', () => {
    expect(parseCurrency(null)).toBeNull();
    expect(parseCurrency(undefined)).toBeNull();
  });

  it.each([
    ['$1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['€45.000', 45000],
    ['12', 12],
    ['1,5', 1.5],
    ['$85,000.00', 85000],
    ['$100K', 100000],
    ['1.5k', 1500],
    ['120 k', 120000],
  ])('parses %p as %p', (text, expected) => {
    expect(parseCurrency(text)).toBe(expected);
  });

  it('does not read the k of a currency word as a thousands suffix', () => {
    expect(parseCurrency('500 kr')).toBe(500);
  });

  it('keeps the suffix-blind reading behind thousandsSuffix: false', () => {
    expect(parseCurrency('$100K', { thousandsSuffix: false })).toBe(100);
    expect(parseCurrency('$1,234.56', { thousandsSuffix: false })).toBe(1234.56);
  });
});

describe('convertToAnnual — nullable bounds (Spec 1695)', () => {
  it('scales only the present min bound', () => {
    const data = { interval: 'hourly', minAmount: 25, maxAmount: null as number | null };
    expect(convertToAnnual(data)).toBe(true);
    expect(data).toEqual({ interval: 'yearly', minAmount: 52000, maxAmount: null });
  });

  it('scales only the present max bound (an undefined min stays undefined)', () => {
    const data: { interval: string; minAmount?: number; maxAmount: number } = {
      interval: 'monthly',
      maxAmount: 4000,
    };
    convertToAnnual(data);
    expect(data.minAmount).toBeUndefined();
    expect(data.maxAmount).toBe(48000);
    expect(data.interval).toBe('yearly');
  });

  it.each(['', null, undefined, 'biweekly', 'per shift'])(
    'is a no-op for the interval %p',
    (interval) => {
      const data = { interval, minAmount: 25, maxAmount: 40 };
      expect(convertToAnnual(data)).toBe(false);
      expect(data).toEqual({ interval, minAmount: 25, maxAmount: 40 });
    },
  );

  it('leaves yearly data alone and reports no change', () => {
    const data = { interval: 'yearly', minAmount: 100000, maxAmount: 150000 };
    expect(convertToAnnual(data)).toBe(false);
    expect(data).toEqual({ interval: 'yearly', minAmount: 100000, maxAmount: 150000 });
  });

  it('does not relabel as yearly when no bound is present', () => {
    const data = { interval: 'hourly', minAmount: null, maxAmount: null };
    expect(convertToAnnual(data)).toBe(false);
    expect(data.interval).toBe('hourly');
  });

  it.each(['HOURLY', 'hour', ' Hourly '])('normalises the interval %p', (interval) => {
    const data = { interval, minAmount: 20, maxAmount: 30 };
    convertToAnnual(data);
    expect(data).toEqual({ interval: 'yearly', minAmount: 41600, maxAmount: 62400 });
  });

  it('rounds float noise to cents', () => {
    const data = { interval: 'hourly', minAmount: 19.99, maxAmount: null };
    convertToAnnual(data);
    expect(data.minAmount).toBe(41579.2);
  });

  it('ignores a NaN bound and scales the other', () => {
    const data = { interval: 'hourly', minAmount: NaN, maxAmount: 30 };
    convertToAnnual(data);
    expect(Number.isNaN(data.minAmount)).toBe(true);
    expect(data.maxAmount).toBe(62400);
  });

  it('annualises a CompensationDto directly', () => {
    const comp = new CompensationDto({
      interval: CompensationInterval.WEEKLY,
      minAmount: 1000,
      currency: 'GBP',
    });
    expect(convertToAnnual(comp)).toBe(true);
    expect(comp).toMatchObject({ interval: 'yearly', minAmount: 52000, currency: 'GBP' });
    expect(comp.maxAmount).toBeUndefined();
  });
});

describe('intervalFromPeriodToken (Spec 1695)', () => {
  it.each([
    ['/hr', 'hourly'],
    [' / hour', 'hourly'],
    ['/h', 'hourly'],
    [' per hour', 'hourly'],
    [' an hour', 'hourly'],
    [' hourly', 'hourly'],
    [' pro Stunde', 'hourly'],
    ['/yr', 'yearly'],
    [' per annum', 'yearly'],
    [' a year', 'yearly'],
    [' p.a.', 'yearly'],
    ['/Jahr', 'yearly'],
    [' par an', 'yearly'],
    [' PER YEAR', 'yearly'],
    [' annually', 'yearly'],
    [' por año', 'yearly'],
    ['/mo', 'monthly'],
    [' per month', 'monthly'],
    [' par mois', 'monthly'],
    ['/wk', 'weekly'],
    ['/day', 'daily'],
    [' pro Tag', 'daily'],
  ])('%p → %p', (token, interval) => {
    expect(intervalFromPeriodToken(token)).toBe(interval);
  });

  it('reads a bare unit or a pay-period field value', () => {
    expect(intervalFromPeriodToken('hr')).toBe('hourly');
    expect(intervalFromPeriodToken('YEAR')).toBe('yearly');
    expect(intervalFromPeriodToken('1 year')).toBe('yearly');
    expect(intervalFromPeriodToken('Monthly')).toBe('monthly');
  });

  it.each([undefined, null, '', '   ', ' per shift', '/m', '/unit', 'biweekly'])(
    '%p → null',
    (token) => {
      expect(intervalFromPeriodToken(token)).toBeNull();
    },
  );
});

describe('extractSalary — per-bound pay-period tokens (Spec 1695)', () => {
  it.each([
    ['$20/hr - $25/hr', 'hourly 20-25 USD'],
    ['$20.00/hr - $25.00/hr', 'hourly 20-25 USD'],
    ['$53,000/yr - $65,000/yr', 'yearly 53000-65000 USD'],
    ['$53,000.00/yr - $65,000.00/yr', 'yearly 53000-65000 USD'],
    ['$4,000/mo - $5,000/mo', 'monthly 4000-5000 USD'],
    ['$4,000/month - $5,000/month', 'monthly 4000-5000 USD'],
    ['$20 per hour - $25 per hour', 'hourly 20-25 USD'],
    ['$25 an hour - $30 an hour', 'hourly 25-30 USD'],
    ['$1,200/wk - $1,500/wk', 'weekly 1200-1500 USD'],
    ['$200/day - $250/day', 'daily 200-250 USD'],
    ['£30,000/yr - £40,000/yr', 'yearly 30000-40000 GBP'],
    ['€45.000/yr - €60.000/yr', 'yearly 45000-60000 EUR'],
    ['45.000 €/Jahr - 60.000 €/Jahr', 'yearly 45000-60000 EUR'],
    ['3.000 € par mois - 4.000 € par mois', 'monthly 3000-4000 EUR'],
    ['$120k/yr - $150k/yr', 'yearly 120000-150000 USD'],
    ['$20 - $25 hourly', 'hourly 20-25 USD'],
    ['$20 - $25 PER HOUR', 'hourly 20-25 USD'],
    ['£30,000 - £40,000 pa', 'yearly 30000-40000 GBP'],
    ['£30,000 - £40,000 p.a.', 'yearly 30000-40000 GBP'],
  ])('%p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
  });

  it.each([
    // The magnitude heuristic called these monthly; the text says yearly.
    ['$20,000 - $25,000 per year', 'yearly 20000-25000 USD'],
    // Lost entirely before: 28000 is monthly-band, 32000 crosses the band.
    ['$28,000 - $32,000/yr', 'yearly 28000-32000 USD'],
    // Weekly and daily cannot be expressed by magnitude at all (magnitude
    // said monthly 1500-2000 and hourly 200-300).
    ['$1,200 - $1,500 per week', 'weekly 1200-1500 USD'],
    ['$1,500 - $2,000 weekly', 'weekly 1500-2000 USD'],
    ['$200 - $300 daily', 'daily 200-300 USD'],
  ])('the stated period beats magnitude: %p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
  });

  it.each([
    ['$90 - $150 /hour', 'hourly 90-150 USD'],
    ['$90-$150+/hr', 'hourly 90-150 USD'],
    ['$115,000 - $149,500 a year', 'yearly 115000-149500 USD'],
    ['$25.00 - $29.00 per hour on W2', 'hourly 25-29 USD'],
  ])('reads a trailing token: %p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
  });

  it('annualises a per-bound hourly range under enforceAnnualSalary', () => {
    expect(extractSalary('$20/hr - $25/hr', { enforceAnnualSalary: true })).toEqual({
      interval: 'hourly',
      minAmount: 41600,
      maxAmount: 52000,
      currency: 'USD',
    });
  });

  it('keeps the caller hint ahead of the text token', () => {
    const result = extractSalary('$28,000/mo - $32,000/mo', {
      interval: CompensationInterval.YEARLY,
    });
    expect(render(result)).toBe('yearly 28000-32000 USD');
  });

  it('rejects two different periods on one range', () => {
    expect(render(extractSalary('$20/hr - $40,000/yr'))).toBe('null');
  });

  it('rejects an explicit hourly range that annualises above the ceiling', () => {
    // Magnitude read this as monthly 400-500; the token says hourly.
    expect(render(extractSalary('$400 - $500/hr'))).toBe('null');
  });

  it('does not treat unrelated words as periods', () => {
    expect(render(extractSalary('$100K - $150K + equity'))).toBe('yearly 100000-150000 USD');
    // Not adjacent to the amount: the magnitude reading stands.
    expect(render(extractSalary('$60k-$80k, paid monthly'))).toBe('yearly 60000-80000 USD');
    // "a head" / "per shift" are not periods.
    expect(render(extractSalary('$20 - $25 a head'))).toBe('hourly 20-25 USD');
    expect(render(extractSalary('$50 - $60 per shift'))).toBe('hourly 50-60 USD');
    // A weekday is not a month.
    expect(render(extractSalary('$50 - $60 a Mon-Fri shift'))).toBe('hourly 50-60 USD');
    expect(render(extractSalary('5 - 7 years experience'))).toBe('null');
  });

  it('reads a period token on the bare (country-tier) path', () => {
    // Magnitude alone reads 20.000 - 25.000 as monthly.
    expect(render(extractSalary('20.000 - 25.000 pro Jahr', { country: Country.GERMANY }))).toBe(
      'yearly 20000-25000 EUR',
    );
    // The bare-path lowerLimit pre-check still rejects small bare figures.
    expect(render(extractSalary('20 - 25/Stunde', { country: Country.GERMANY }))).toBe('null');
  });

  it('routes the per-bound shape through salaryToCompensation', () => {
    expect(salaryToCompensation('$53,000.00/yr - $65,000.00/yr')).toMatchObject({
      interval: 'yearly',
      minAmount: 53000,
      maxAmount: 65000,
      currency: 'USD',
    });
  });
});

describe('extractSalary — single bound with a period token (Spec 1695)', () => {
  it.each([
    ['$25/hr+', { interval: 'hourly', minAmount: 25, maxAmount: null, currency: 'USD' }],
    ['up to $4,000/mo', { interval: 'monthly', minAmount: null, maxAmount: 4000, currency: 'USD' }],
    ['from $28,000 per year', { interval: 'yearly', minAmount: 28000, maxAmount: null, currency: 'USD' }],
    // Magnitude alone would call 1,200 monthly.
    ['starting at $1,200/wk', { interval: 'weekly', minAmount: 1200, maxAmount: null, currency: 'USD' }],
  ])('%p', (text, expected) => {
    expect(extractSalary(text)).toEqual(expected);
  });

  it('annualises a tokenised single bound under enforceAnnualSalary', () => {
    expect(extractSalary('up to $4,000/mo', { enforceAnnualSalary: true })).toEqual({
      interval: 'monthly',
      minAmount: null,
      maxAmount: 48000,
      currency: 'USD',
    });
  });

  it('never truncates a range to a floor by backing out of a token', () => {
    // "to 60" has no currency, so it is not a range either: no salary at all.
    expect(render(extractSalary('from $40/hr to 60/hr'))).toBe('null');
  });
});

describe('extractSalary — "to" range separator (Spec 1695)', () => {
  it.each([
    ['$100,000 to $150,000', 'yearly 100000-150000 USD'],
    ['$40/hr to $120/hr', 'hourly 40-120 USD'],
    ['$15 to $25 per hour', 'hourly 15-25 USD'],
    ['The total compensation range for this role is $220,000 to $290,000', 'yearly 220000-290000 USD'],
    ['USD 90,000 TO USD 110,000', 'yearly 90000-110000 USD'],
    ['45.000 € to 60.000 €', 'yearly 45000-60000 EUR'],
  ])('%p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
  });

  it('requires a currency on both amounts', () => {
    expect(render(extractSalary('$5 to 10 people on the team'))).toBe('null');
    expect(render(extractSalary('45.000 € to 60.000'))).toBe('null');
  });

  it('does not read scaled figures as a salary', () => {
    expect(render(extractSalary('grew from $5 to $10 million'))).toBe('null');
    expect(render(extractSalary('$5 - $10 million in funding'))).toBe('null');
    expect(render(extractSalary('$5 - $10 Million in funding'))).toBe('null');
    expect(render(extractSalary('raised $11M to our engineers'))).toBe('null');
  });

  it('does not pull a range from prose numbers', () => {
    expect(render(extractSalary('5 to 7 years'))).toBe('null');
    expect(render(extractSalary('5 to 7 years', { country: Country.GERMANY }))).toBe('null');
  });
});

describe('extractSalary — a benefit "to" range never shadows the salary (Spec 1695)', () => {
  // The earlier grammar read the dash range in each of these; the "to" range
  // before it is a bonus / stipend / relocation / commission / referral figure.
  it.each([
    ['Sign-on bonus of $2,000 to $5,000. Base salary $90,000 - $110,000 per year.', 'yearly 90000-110000 USD'],
    ['stipend from $500 to $1,000. The pay range is $120,000 - $140,000.', 'yearly 120000-140000 USD'],
    ['Relocation assistance of $5,000 to $10,000 is available. Salary: $95,000-$125,000', 'yearly 95000-125000 USD'],
    ['Commission of $1,000 to $3,000 per month plus base of $45,000 - $55,000 annually', 'yearly 45000-55000 USD'],
    ['Referral bonus $500 to $1,500; hourly pay $22 - $28', 'hourly 22-28 USD'],
  ])('%p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
    expect(render(extractSalary(text, { grammar: 'legacy' }))).toBe(expected);
  });

  it('keeps the salary, not the bonus, under enforceAnnualSalary', () => {
    const out = postProcessCompensation({
      description: 'Sign-on bonus of $2,000 to $5,000. Base salary $90,000 - $110,000 per year.',
      enforceAnnualSalary: true,
    });
    expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 90000, maxAmount: 110000 });
    expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
  });

  it('returns nothing when the only "to" range is a benefit', () => {
    expect(render(extractSalary('Sign-on bonus of $2,000 to $5,000'))).toBe('null');
    expect(render(extractSalary('Relocation: $5,000 to $10,000 per year'))).toBe('null');
  });

  it('prefers a qualified range over an unqualified "to" range before it', () => {
    expect(
      render(extractSalary('Budget: nope. $10,000 to $20,000 of hardware. Salary $90,000 to $110,000')),
    ).toBe('yearly 90000-110000 USD');
    expect(render(extractSalary('$10,000 to $20,000 of hardware; $90,000 - $110,000'))).toBe(
      'yearly 90000-110000 USD',
    );
  });

  it('reads a salary "to" range whose nearest keyword is a salary word', () => {
    expect(render(extractSalary('We pay a bonus, and the salary is $90,000 to $110,000'))).toBe(
      'yearly 90000-110000 USD',
    );
  });

  it('never cuts a word to find a keyword', () => {
    // 80 characters back from the first "$" lands inside "database"; the
    // fragment "base" must not turn the hardware figure into a qualified range.
    const text =
      'x'.repeat(10) + ' database ' + 'y'.repeat(74) + ' $10,000 to $20,000 of hardware; $90,000 - $110,000';
    expect(text.indexOf('$') - 80).toBe(text.indexOf('database') + 4);
    expect(render(extractSalary(text))).toBe('yearly 90000-110000 USD');
  });
});

describe('extractSalary — a benefit single bound is not the salary (Spec 1695)', () => {
  it.each([
    'relocation assistance up to $10,000',
    '401(k) match up to $5,000 per year',
    'Tuition reimbursement up to $5,250 per year',
    'Referral bonus of up to $2,500',
    'Learning stipend: up to $1,500 annually',
    'Sign-on bonus from $2,000',
  ])('%p → null', (text) => {
    expect(render(extractSalary(text))).toBe('null');
  });

  it('still reads a single bound whose nearest keyword is a salary word', () => {
    expect(render(extractSalary('Stipend aside, the salary is up to $90,000 annually'))).toBe(
      'yearly null-90000 USD',
    );
  });

  it('upperBoundNeedsSalaryCue — an upper-only figure needs a salary word in its clause', () => {
    expect(render(extractSalary('up to $4,000/mo', { upperBoundNeedsSalaryCue: true }))).toBe('null');
    expect(
      render(extractSalary('Pay: up to $4,000/mo', { upperBoundNeedsSalaryCue: true })),
    ).toBe('monthly null-4000 USD');
    // A benefit word anywhere in the clause refuses it, even with a cue.
    expect(
      render(
        extractSalary('Bonus and base pay up to $4,000/mo', { upperBoundNeedsSalaryCue: true }),
      ),
    ).toBe('null');
    // A lower bound is not affected.
    expect(render(extractSalary('from $28,000 per year', { upperBoundNeedsSalaryCue: true }))).toBe(
      'yearly 28000-null USD',
    );
  });
});

describe('extractSalary — legacy grammar keeps the earlier behaviour (Spec 1695)', () => {
  const original = process.env[GRAMMAR_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[GRAMMAR_ENV];
    else process.env[GRAMMAR_ENV] = original;
  });

  // Outputs of the grammar before Spec 1695, recorded against the unmodified helper.
  const LEGACY_CASES: ReadonlyArray<readonly [string, string]> = [
    ['$20/hr - $25/hr', 'null'],
    ['$53,000.00/yr - $65,000.00/yr', 'null'],
    ['$4,000/mo - $5,000/mo', 'null'],
    ['45.000 €/Jahr - 60.000 €/Jahr', 'null'],
    ['$20,000 - $25,000 per year', 'monthly 20000-25000 USD'],
    ['$400 - $500/hr', 'monthly 400-500 USD'],
    ['$25/hr+', 'null'],
    ['$100,000 to $150,000', 'null'],
    ['$40/hr to $120/hr', 'null'],
    ['from $100,000 to $150,000 per year', 'null'],
    ['$5 - $10 million in funding', 'hourly 5-10 USD'],
    ['from $40/hr to 60/hr', 'hourly 40-null USD'],
    ['$200 - $300 daily', 'hourly 200-300 USD'],
    ['$100,000 - $150,000', 'yearly 100000-150000 USD'],
  ];

  it('grammar: legacy — a bare-path token is ignored (magnitude decides)', () => {
    expect(
      render(extractSalary('20.000 - 25.000 pro Jahr', { country: Country.GERMANY, grammar: 'legacy' })),
    ).toBe('monthly 20000-25000 EUR');
  });

  it.each(LEGACY_CASES)('grammar: legacy — %p → %s', (text, expected) => {
    expect(render(extractSalary(text, { grammar: 'legacy' }))).toBe(expected);
  });

  it.each(LEGACY_CASES)('EVER_JOBS_SALARY_GRAMMAR=legacy — %p → %s', (text, expected) => {
    process.env[GRAMMAR_ENV] = 'legacy';
    expect(render(extractSalary(text))).toBe(expected);
  });

  it('reads the variable case- and whitespace-insensitively', () => {
    process.env[GRAMMAR_ENV] = ' LEGACY ';
    expect(render(extractSalary('$20/hr - $25/hr'))).toBe('null');
  });

  it('an explicit option beats the variable', () => {
    process.env[GRAMMAR_ENV] = 'legacy';
    expect(render(extractSalary('$20/hr - $25/hr', { grammar: 'extended' }))).toBe(
      'hourly 20-25 USD',
    );
  });

  it('an unknown or empty value selects the extended grammar', () => {
    for (const value of ['', 'extended', 'v2', 'true']) {
      process.env[GRAMMAR_ENV] = value;
      expect(render(extractSalary('$20/hr - $25/hr'))).toBe('hourly 20-25 USD');
    }
  });
});

describe('extractSalary — salary field values seen on public feeds (Spec 1695)', () => {
  // Short field values of the shapes public job feeds publish, with the
  // expected reading. Unchanged ones pin that the extended grammar did not
  // move a value the earlier grammar already read.
  it.each([
    ['$90k - $105k', 'yearly 90000-105000 USD'],
    ['$80k - $150k', 'yearly 80000-150000 USD'],
    ['$90 - $150 /hour', 'hourly 90-150 USD'],
    ['$120 - $170 /hour', 'hourly 120-170 USD'],
    ['$50-$75 /hour', 'hourly 50-75 USD'],
    ['$10K-$20K', 'monthly 10000-20000 USD'],
    ['$35,3k- $52k', 'null'],
    ['OTE $25k - $35k', 'null'],
    ['$20k -$35k', 'null'],
    ['$25.00 - $29.00 per hour on W2', 'hourly 25-29 USD'],
    ['$115,000 - $149,500 a year', 'yearly 115000-149500 USD'],
    ['$90-$150+/hr, with vetted clients', 'hourly 90-150 USD'],
    ['$120-$170/hr Remote', 'hourly 120-170 USD'],
    ['$160,000–$200,000 CAD/USD (based on experience)', 'yearly 160000-200000 USD'],
    ['$137,750.00 - $185,000.00', 'yearly 137750-185000 USD'],
    ['$1mm - $2mm of work', 'null'],
    ['$14 per hour.', 'null'],
    ['$40/hr to $120/hr pending seniority', 'hourly 40-120 USD'],
    ['$15 to $25 per hour.', 'hourly 15-25 USD'],
  ])('%p → %s', (text, expected) => {
    expect(render(extractSalary(text))).toBe(expected);
  });
});

describe('extractSalary — near-misses on long whitespace runs stay linear (Spec 1695)', () => {
  // Each whitespace run has one owning quantifier in the extended grammar.
  // Two competing `\s*` make these inputs quadratic (seconds at this size).
  const RUN = ' '.repeat(50_000);
  it.each([
    ['$100' + RUN + 'x', 'null'],
    // "to x" is not a second amount, so this is a genuine $100 floor.
    ['from $100' + RUN + 'to x', 'hourly 100-null USD'],
    ['100 €' + RUN + 'to x', 'null'],
    ['$100/hr' + RUN + 'x', 'null'],
  ])('input %#', (text, expected) => {
    const started = Date.now();
    expect(render(extractSalary(text))).toBe(expected);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('hasSalaryAmount (Spec 1695)', () => {
  it.each([
    [{ minAmount: 1 }, true],
    [{ maxAmount: 90000 }, true],
    [{ minAmount: 0, maxAmount: 0 }, false],
    [{ minAmount: null, maxAmount: undefined }, false],
    [{ minAmount: NaN }, false],
    [{ minAmount: -5 }, false],
    [null, false],
    [undefined, false],
  ])('%p → %p', (compensation, expected) => {
    expect(hasSalaryAmount(compensation)).toBe(expected);
  });
});

describe('postProcessCompensation (Spec 1695)', () => {
  const original = process.env[GRAMMAR_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[GRAMMAR_ENV];
    else process.env[GRAMMAR_ENV] = original;
  });

  const comp = (partial: Partial<CompensationDto>): CompensationDto => new CompensationDto(partial);

  it('keeps a direct yearly range and marks it direct_data', () => {
    const direct = comp({ interval: CompensationInterval.YEARLY, minAmount: 100000, maxAmount: 150000 });
    const out = postProcessCompensation({ compensation: direct });
    expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
    expect(out.compensation).toBe(direct);
  });

  it('annualises a direct hourly range without mutating the input', () => {
    const direct = comp({ interval: CompensationInterval.HOURLY, minAmount: 50, maxAmount: 100 });
    const out = postProcessCompensation({ compensation: direct, enforceAnnualSalary: true });
    expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 104000, maxAmount: 208000 });
    expect(direct).toMatchObject({ interval: 'hourly', minAmount: 50, maxAmount: 100 });
    expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
  });

  it('annualises a min-only hourly direct salary', () => {
    const out = postProcessCompensation({
      compensation: comp({ interval: CompensationInterval.HOURLY, minAmount: 25 }),
      enforceAnnualSalary: true,
    });
    expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 52000 });
    expect(out.compensation?.maxAmount).toBeUndefined();
    expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
  });

  it('annualises a max-only monthly direct salary and keeps its source', () => {
    const out = postProcessCompensation({
      compensation: comp({ interval: CompensationInterval.MONTHLY, maxAmount: 4000 }),
      enforceAnnualSalary: true,
    });
    expect(out.compensation).toMatchObject({ interval: 'yearly', maxAmount: 48000 });
    expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
  });

  it('keeps the source of a max-only yearly salary without enforcement', () => {
    const out = postProcessCompensation({
      compensation: comp({ interval: CompensationInterval.YEARLY, maxAmount: 90000 }),
    });
    expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
  });

  it('clears the source of a 0 / 0 placeholder', () => {
    const out = postProcessCompensation({
      compensation: comp({ interval: CompensationInterval.YEARLY, minAmount: 0, maxAmount: 0 }),
    });
    expect(out.salarySource).toBeUndefined();
  });

  it('reads the description for the USA, in its own period', () => {
    const out = postProcessCompensation({
      description: 'Salary range: $120,000 - $180,000 per year',
      country: Country.USA,
    });
    expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
    expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 120000, maxAmount: 180000 });
  });

  it('labels an annualised description salary yearly', () => {
    const out = postProcessCompensation({
      description: 'Pay: $20/hr - $25/hr',
      enforceAnnualSalary: true,
    });
    expect(out.compensation).toMatchObject({
      interval: 'yearly',
      minAmount: 41600,
      maxAmount: 52000,
      currency: 'USD',
    });
    expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
  });

  it('accepts an upper-only description figure', () => {
    const out = postProcessCompensation({ description: 'Compensation: up to $90,000 annually' });
    expect(out.compensation).toMatchObject({ interval: 'yearly', maxAmount: 90000 });
    expect(out.compensation?.minAmount).toBeUndefined();
    expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
  });

  it.each([
    'We offer relocation assistance up to $10,000.',
    'Benefits: 401(k) match up to $5,000 per year.',
    'Tuition reimbursement up to $5,250 per year',
    'Referral bonus of up to $2,500',
    'Learning stipend: up to $1,500 annually',
    // No salary word in the clause at all.
    'Hardware budget aside, you get up to $3,000 for travel',
    'Up to $4,000/mo.',
  ])('does not take a benefit or uncued upper-only figure as the salary: %p', (description) => {
    expect(postProcessCompensation({ description })).toEqual({
      compensation: undefined,
      salarySource: undefined,
    });
  });

  it('lets a description salary replace a compensation that has no amount', () => {
    const out = postProcessCompensation({
      compensation: comp({ currency: 'USD' }),
      description: 'Base: $53,000.00/yr - $65,000.00/yr',
    });
    expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 53000, maxAmount: 65000 });
    expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
  });

  it('does not read the description outside the USA', () => {
    const out = postProcessCompensation({
      description: 'Salary range: $120,000 - $180,000 per year',
      country: Country.UK,
    });
    expect(out.compensation).toBeUndefined();
    expect(out.salarySource).toBeUndefined();
  });

  it('returns no source when nothing is known', () => {
    expect(postProcessCompensation({})).toEqual({ compensation: undefined, salarySource: undefined });
  });

  describe('legacy rules (grammar: legacy / EVER_JOBS_SALARY_GRAMMAR=legacy)', () => {
    it('does not annualise a single-bound direct salary and clears a max-only source', () => {
      const direct = comp({ interval: CompensationInterval.MONTHLY, maxAmount: 4000 });
      const out = postProcessCompensation({
        compensation: direct,
        enforceAnnualSalary: true,
        grammar: 'legacy',
      });
      expect(out.compensation).toBe(direct);
      expect(out.compensation).toMatchObject({ interval: 'monthly', maxAmount: 4000 });
      expect(out.salarySource).toBeUndefined();
    });

    it('annualises a two-bound direct salary', () => {
      const out = postProcessCompensation({
        compensation: comp({ interval: CompensationInterval.HOURLY, minAmount: 50, maxAmount: 100 }),
        enforceAnnualSalary: true,
        grammar: 'legacy',
      });
      expect(out.compensation).toMatchObject({ interval: 'yearly', minAmount: 104000, maxAmount: 208000 });
      expect(out.salarySource).toBe(SalarySource.DIRECT_DATA);
    });

    it('keeps the source interval on a pre-annualised description salary', () => {
      process.env[GRAMMAR_ENV] = 'legacy';
      const out = postProcessCompensation({
        description: 'Pay: $20 - $25/hr',
        enforceAnnualSalary: true,
      });
      expect(out.compensation).toMatchObject({ interval: 'hourly', minAmount: 41600, maxAmount: 52000 });
      expect(out.salarySource).toBe(SalarySource.DESCRIPTION);
    });

    it('drops an upper-only description figure and never overrides a compensation object', () => {
      expect(
        postProcessCompensation({ description: 'up to $90,000 annually', grammar: 'legacy' }),
      ).toEqual({ compensation: undefined, salarySource: undefined });

      const currencyOnly = comp({ currency: 'USD' });
      const out = postProcessCompensation({
        compensation: currencyOnly,
        description: '$120,000 - $180,000',
        grammar: 'legacy',
      });
      expect(out.compensation).toBe(currencyOnly);
      expect(out.salarySource).toBeUndefined();
    });
  });
});
