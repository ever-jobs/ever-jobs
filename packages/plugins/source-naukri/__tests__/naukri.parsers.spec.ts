/**
 * Spec 1712 - pure Naukri parsers: salary, location, posted date, block
 * detection and the small coercions. Table-driven; no network.
 */
import { CompensationInterval, Country } from '@ever-jobs/models';
import {
  coerceNaukriBody,
  detectNaukriBlock,
  finiteNumberOrNull,
  istDay,
  naukriPostedCutoffDay,
  naukriSeoKey,
  parseNaukriLocationLabel,
  parseNaukriPostedDate,
  parseNaukriSalary,
  parseNaukriSkills,
  placeholderLabel,
  resolveNaukriUrl,
} from '../src/naukri.parsers';
import { parseNaukriMode } from '../src/naukri.constants';

const CLOCK = Date.parse('2026-09-24T12:00:00Z');

describe('parseNaukriSalary (Spec 1712)', () => {
  const Y = CompensationInterval.YEARLY;
  const M = CompensationInterval.MONTHLY;

  it.each<[string, number | null, number, CompensationInterval | null]>([
    ['12-16 Lacs P.A.', 1_200_000, 1_600_000, Y],
    ['80 Lacs-1.2 Cr P.A.', 8_000_000, 12_000_000, Y],
    ['1-5 Cr', 10_000_000, 50_000_000, Y],
    ['12-16 Lakhs P.A.', 1_200_000, 1_600_000, Y],
    ['1.5-2 Crore P.A.', 15_000_000, 20_000_000, Y],
    ['4.5 LPA', 450_000, 450_000, Y],
    ['Up to 10 Lacs P.A.', null, 1_000_000, Y],
    ['2,50,000-3,50,000 P.A.', 250_000, 350_000, Y],
    ['20,000-30,000 P.M.', 20_000, 30_000, M],
    ['5 to 8 Lacs', 500_000, 800_000, Y],
    ['12 \u2013 16 Lacs P.A.', 1_200_000, 1_600_000, Y],
    ['Upto 6 Lakh', null, 600_000, Y],
    ['3,50,000 P.A.', 350_000, 350_000, Y],
    ['0-3 Lacs P.A.', 0, 300_000, Y],
    ['1 Lac - 1.5 Lacs P.M.', 100_000, 150_000, M],
    ['2,50,000-3,50,000', 250_000, 350_000, null],
    ['  12-16   Lacs   P.A. ', 1_200_000, 1_600_000, Y],
  ])('%j -> %p..%p %p INR', (label, min, max, interval) => {
    const c = parseNaukriSalary(label);
    expect(c).not.toBeNull();
    expect(c?.minAmount).toBe(min);
    expect(c?.maxAmount).toBe(max);
    expect(c?.interval).toBe(interval);
    expect(c?.currency).toBe('INR');
  });

  it.each<[unknown]>([
    ['Not disclosed'],
    ['Not Disclosed'],
    [''],
    ['   '],
    ['3-5'],
    ['16-12 Lacs P.A.'],
    ['Best in Industry'],
    ['As per industry standards'],
    ['Unpaid'],
    ['Competitive'],
    [null],
    [undefined],
    [42],
  ])('%j -> null', (label) => {
    expect(parseNaukriSalary(label as string)).toBeNull();
  });

  it('refuses an over-long label quickly (bounded regex work)', () => {
    const started = Date.now();
    expect(parseNaukriSalary(`${'1 '.repeat(5000)}Lacs`)).toBeNull();
    expect(parseNaukriSalary(`12-16 Lacs P.A.${' x'.repeat(200)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('never emits NaN', () => {
    for (const label of ['. Lacs', '.-. Cr', 'Lacs-Cr', '1.2.3-4 Lacs', 'Up to Lacs']) {
      const c = parseNaukriSalary(label);
      if (c) {
        expect(Number.isNaN(c.maxAmount)).toBe(false);
        expect(Number.isNaN(c.minAmount)).toBe(false);
      }
    }
  });
});

describe('parseNaukriLocationLabel (Spec 1712)', () => {
  it('splits a city list into one entry per city, each in India', () => {
    const r = parseNaukriLocationLabel('Bengaluru, Hyderabad, Pune');
    expect(r.locations.map((l) => l.city)).toEqual(['Bengaluru', 'Hyderabad', 'Pune']);
    for (const l of r.locations) expect(l.country).toBe(Country.INDIA);
    expect(r.location.country).toBe(Country.INDIA);
    expect(r.isRemote).toBe(false);
    expect(r.workFromHomeType).toBeNull();
  });

  it('reads a leading Hybrid qualifier and never turns a city into a state', () => {
    const r = parseNaukriLocationLabel('Hybrid - Bengaluru, Chennai');
    expect(r.locations.map((l) => l.city)).toEqual(['Bengaluru', 'Chennai']);
    for (const l of r.locations) expect(l.state ?? null).toBeNull();
    expect(r.workFromHomeType).toBe('Hybrid');
    expect(r.isRemote).toBe(false);
  });

  it('treats a bare Remote label as remote with no site', () => {
    const r = parseNaukriLocationLabel('Remote');
    expect(r.locations).toEqual([]);
    expect(r.isRemote).toBe(true);
    expect(r.workFromHomeType).toBe('Remote');
    expect(r.location.country).toBe(Country.INDIA);
  });

  it('maps temporary WFH to Remote and drops the parenthetical', () => {
    const r = parseNaukriLocationLabel('Temp. WFH - Mumbai (All Areas)');
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0].city).toBe('Mumbai');
    expect(r.locations[0].country).toBe(Country.INDIA);
    expect(r.isRemote).toBe(true);
    expect(r.workFromHomeType).toBe('Remote');
  });

  it('keeps a literal country named in the label', () => {
    const r = parseNaukriLocationLabel('Dubai, United Arab Emirates');
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0].city).toBe('Dubai');
    expect(r.locations[0].country).toBe('United Arab Emirates');
    expect(r.location.country).toBe('United Arab Emirates');
  });

  it('keeps "Delhi / NCR" as one entry', () => {
    const r = parseNaukriLocationLabel('Delhi / NCR');
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0].country).toBe(Country.INDIA);
  });

  it.each<[string, string[], boolean, string | null]>([
    ['Bengaluru(Whitefield)', ['Bengaluru'], false, null],
    ['Work from office - Pune', ['Pune'], false, 'Work from office'],
    ['Work From Office', [], false, 'Work from office'],
    ['Bengaluru, Remote', ['Bengaluru'], true, 'Remote'],
    ['Mumbai (Hybrid)', ['Mumbai'], false, 'Hybrid'],
    ['WFH', [], true, 'Remote'],
    ['Work from home - Kolkata', ['Kolkata'], true, 'Remote'],
    ['Pune, Pune', ['Pune'], false, null],
  ])('%j -> cities %j, remote %p, %p', (label, cities, isRemote, wfh) => {
    const r = parseNaukriLocationLabel(label);
    expect(r.locations.map((l) => l.city)).toEqual(cities);
    expect(r.isRemote).toBe(isRemote);
    expect(r.workFromHomeType).toBe(wfh);
  });

  it('folds a named India onto the city', () => {
    const r = parseNaukriLocationLabel('Kolkata, India');
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0].city).toBe('Kolkata');
    expect(r.locations[0].country).toBe('India');
  });

  it.each([[null], [undefined], [''], ['   ']])('%j -> India, no entries', (label) => {
    const r = parseNaukriLocationLabel(label as string | null);
    expect(r.location.country).toBe(Country.INDIA);
    expect(r.locations).toEqual([]);
    expect(r.isRemote).toBe(false);
    expect(r.workFromHomeType).toBeNull();
  });

  it('bounds a pathological label', () => {
    const r = parseNaukriLocationLabel(Array.from({ length: 200 }, (_, i) => `City${i}`).join(', '));
    expect(r.locations.length).toBeLessThanOrEqual(50);
  });
});

describe('parseNaukriPostedDate (Spec 1712, IST days)', () => {
  const AUG_7 = Date.parse('2026-08-07T00:00:00Z');

  it.each<[string | null, unknown, number, string | null]>([
    ['Today', null, CLOCK, '2026-09-24'],
    ['Just Now', null, CLOCK, '2026-09-24'],
    ['Few Hours Ago', null, CLOCK, '2026-09-24'],
    ['5 Hours Ago', null, CLOCK, '2026-09-24'],
    ['3 Days Ago', null, CLOCK, '2026-09-21'],
    ['1 Day Ago', null, CLOCK, '2026-09-23'],
    ['Yesterday', null, CLOCK, '2026-09-23'],
    ['30+ Days Ago', AUG_7, CLOCK, '2026-08-07'],
    ['30+ Days Ago', null, CLOCK, '2026-08-25'],
    [null, AUG_7, CLOCK, '2026-08-07'],
    ['', AUG_7, CLOCK, '2026-08-07'],
    ['garbage', null, CLOCK, null],
    ['garbage', AUG_7, CLOCK, '2026-08-07'],
    [null, null, CLOCK, null],
    ['5 Days Ago', null, Date.parse('2026-10-02T06:00:00Z'), '2026-09-27'],
    ['Today', null, Date.parse('2026-09-24T20:00:00Z'), '2026-09-25'],
    [null, AUG_7 / 1000, CLOCK, '2026-08-07'],
    [null, String(AUG_7), CLOCK, '2026-08-07'],
    [null, CLOCK + 3 * 86_400_000, CLOCK, null],
    [null, Date.parse('1999-12-31T00:00:00Z'), CLOCK, null],
    [null, Number.NaN, CLOCK, null],
  ])('label %j, createdDate %p, clock %p -> %p', (label, created, now, expected) => {
    expect(parseNaukriPostedDate(label, created, now)).toBe(expected);
  });

  it('a specific label beats createdDate', () => {
    expect(parseNaukriPostedDate('Today', AUG_7, CLOCK)).toBe('2026-09-24');
  });

  it('istDay shifts by +05:30', () => {
    expect(istDay(Date.parse('2026-09-24T18:29:59Z'))).toBe('2026-09-24');
    expect(istDay(Date.parse('2026-09-24T18:30:00Z'))).toBe('2026-09-25');
    expect(istDay(Number.NaN)).toBeNull();
  });

  it('naukriPostedCutoffDay rounds hoursOld up to whole days', () => {
    expect(naukriPostedCutoffDay(72, CLOCK)).toBe('2026-09-21');
    expect(naukriPostedCutoffDay(25, CLOCK)).toBe('2026-09-22');
    expect(naukriPostedCutoffDay(0, CLOCK)).toBeNull();
    expect(naukriPostedCutoffDay(Number.NaN, CLOCK)).toBeNull();
  });
});

describe('detectNaukriBlock (Spec 1712)', () => {
  const axiosError = (status: number, data: unknown): Error =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data },
    });

  it('matches the 406 recaptcha refusal', () => {
    const err = axiosError(406, { message: 'recaptcha required', statusCode: 406 });
    expect(detectNaukriBlock(err)).toBe('HTTP 406: recaptcha required');
  });

  it('matches a 200 body carrying the captcha message', () => {
    expect(detectNaukriBlock({ message: 'recaptcha required' })).toBe('HTTP 200: recaptcha required');
    expect(detectNaukriBlock({ message: 'recaptcha required', statusCode: 406 })).toBe(
      'HTTP 200 (body statusCode 406): recaptcha required',
    );
  });

  it('matches a JSON string body carrying the captcha message', () => {
    expect(detectNaukriBlock('{"message":"recaptcha required","statusCode":406}')).toMatch(/recaptcha/);
  });

  it('matches an HTML challenge page', () => {
    expect(detectNaukriBlock('<html><title>Just a moment...</title></html>')).toBe(
      'HTTP 200: bot challenge page',
    );
    expect(detectNaukriBlock(axiosError(503, '<html>Just a moment...</html>'))).toBe(
      'HTTP 503: bot challenge page',
    );
  });

  it('matches a bare 403 and a 406 without a body', () => {
    expect(detectNaukriBlock(axiosError(403, ''))).toBe('HTTP 403: request refused');
    expect(detectNaukriBlock(axiosError(406, undefined))).toBe('HTTP 406: request refused');
  });

  it('does not match a 404, a timeout, a reset, or a normal body', () => {
    expect(detectNaukriBlock(axiosError(404, { message: 'Not Found' }))).toBeNull();
    const timeout = Object.assign(new Error('timeout of 20000ms exceeded'), {
      code: 'ECONNABORTED',
      isAxiosError: true,
    });
    expect(detectNaukriBlock(timeout)).toBeNull();
    expect(detectNaukriBlock(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBeNull();
    expect(detectNaukriBlock({ jobDetails: [], noOfJobs: 0 })).toBeNull();
    expect(detectNaukriBlock('<html><body>ordinary page</body></html>')).toBeNull();
    expect(detectNaukriBlock(null)).toBeNull();
    expect(detectNaukriBlock(undefined)).toBeNull();
  });

  it('caps the detail at 300 characters', () => {
    const err = axiosError(406, { message: `captcha ${'x'.repeat(1000)}` });
    expect(detectNaukriBlock(err)?.length).toBe(300);
  });
});

describe('small coercions (Spec 1712)', () => {
  it('resolveNaukriUrl keeps absolute links and resolves relative ones', () => {
    expect(resolveNaukriUrl('/job-listings-x-1')).toBe('https://www.naukri.com/job-listings-x-1');
    expect(resolveNaukriUrl('acme-jobs-careers-1')).toBe('https://www.naukri.com/acme-jobs-careers-1');
    expect(resolveNaukriUrl('https://www.naukri.com/job-listings-y-2')).toBe(
      'https://www.naukri.com/job-listings-y-2',
    );
    expect(resolveNaukriUrl('javascript:alert(1)')).toBeNull();
    expect(resolveNaukriUrl('')).toBeNull();
    expect(resolveNaukriUrl(null)).toBeNull();
    expect(resolveNaukriUrl(42)).toBeNull();
  });

  it('parseNaukriSkills trims, drops empties and dedupes case-insensitively', () => {
    expect(parseNaukriSkills('Node.Js, REST, Microservices ,AWS, rest,, ')).toEqual([
      'Node.Js',
      'REST',
      'Microservices',
      'AWS',
    ]);
    expect(parseNaukriSkills('')).toBeNull();
    expect(parseNaukriSkills(' , ,')).toBeNull();
    expect(parseNaukriSkills(undefined)).toBeNull();
  });

  it('finiteNumberOrNull never yields NaN', () => {
    expect(finiteNumberOrNull('3.9')).toBe(3.9);
    expect(finiteNumberOrNull(1234)).toBe(1234);
    expect(finiteNumberOrNull('')).toBeNull();
    expect(finiteNumberOrNull('n/a')).toBeNull();
    expect(finiteNumberOrNull(Number.NaN)).toBeNull();
    expect(finiteNumberOrNull(null)).toBeNull();
  });

  it('naukriSeoKey slugs the term', () => {
    expect(naukriSeoKey('Node JS')).toBe('node-js-jobs');
    expect(naukriSeoKey('C++ / .NET developer')).toBe('c-net-developer-jobs');
    expect(naukriSeoKey('')).toBe('-jobs');
  });

  it('coerceNaukriBody parses JSON text and leaves other text alone', () => {
    expect(coerceNaukriBody('{"jobDetails":[]}')).toEqual({ jobDetails: [] });
    expect(coerceNaukriBody('<html></html>')).toBe('<html></html>');
    expect(coerceNaukriBody('{broken')).toBe('{broken');
    const obj = { a: 1 };
    expect(coerceNaukriBody(obj)).toBe(obj);
  });

  it('placeholderLabel returns the first label of a type', () => {
    const p = [
      { type: 'experience', label: '5-8 Yrs' },
      { type: 'salary', label: '12-16 Lacs P.A.' },
      { type: 'salary', label: 'second' },
    ];
    expect(placeholderLabel(p, 'salary')).toBe('12-16 Lacs P.A.');
    expect(placeholderLabel(p, 'location')).toBeNull();
    expect(placeholderLabel(null, 'salary')).toBeNull();
  });

  it('parseNaukriMode accepts current|legacy and flags anything else', () => {
    expect(parseNaukriMode(undefined)).toBe('current');
    expect(parseNaukriMode('')).toBe('current');
    expect(parseNaukriMode(' LEGACY ')).toBe('legacy');
    expect(parseNaukriMode('current')).toBe('current');
    expect(parseNaukriMode('old')).toBeNull();
  });
});
