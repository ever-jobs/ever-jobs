/**
 * Spec 1689 (fork-sync hardening) — Harri country inference.
 *
 * Spec 5125 routed Harri's address parsing through the shared parser and
 * dropped the `US` / `GB` country stamps the address shape implied. They are
 * restored on top of the shared parser (default on) and can be switched off
 * with HARRI_LOCATION_HEURISTICS=false.
 */
import 'reflect-metadata';
import { HarriService } from '../src/harri.service';
import { harriLocationHeuristicsEnabled } from '../src/harri.constants';

type Loc = { city: string | null; state: string | null; country: string | null; raw?: string | null };

describe('HarriService location heuristics (HARRI_LOCATION_HEURISTICS)', () => {
  const saved = process.env.HARRI_LOCATION_HEURISTICS;
  let service: HarriService;
  const parseAddress = (raw: string): Loc => (service as any).parseAddressString(raw);
  const extract = (html: string): Loc => (service as any).extractLocation(html);
  const build = (detail: Record<string, unknown>) => (service as any).buildLocation(detail);

  beforeEach(() => {
    delete process.env.HARRI_LOCATION_HEURISTICS;
    service = new HarriService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.HARRI_LOCATION_HEURISTICS;
    else process.env.HARRI_LOCATION_HEURISTICS = saved;
  });

  it('stamps US on a US address shape by default', () => {
    expect(parseAddress('San Jose, CA 95130')).toMatchObject({ city: 'San Jose', state: 'CA', country: 'US' });
    expect(parseAddress('Now hiring at 1030 El Paseo, San Jose, CA 95130')).toMatchObject({
      state: 'CA',
      country: 'US',
    });
  });

  it('does not stamp US when the 2-letter token is not a US state', () => {
    // The pre-5125 code stamped US on both of these.
    expect(parseAddress('Leeds, ZZ').country).toBeNull();
    expect(parseAddress('Toronto, ON').country).toBeNull();
  });

  it('keeps a country the shared parser found', () => {
    expect(parseAddress('Dublin, Ireland').country).toBe('Ireland');
  });

  it('stamps US on the "City, ST 12345" HTML fallback', () => {
    const loc = extract('<html><body><p>Visit us: Austin, TX 78701</p></body></html>');
    expect(loc).toMatchObject({ state: 'TX', country: 'US', raw: 'Austin, TX 78701' });
  });

  it('stamps GB on the UK postcode HTML fallback', () => {
    const loc = extract('<html><body><p>Our kitchen: Manchester, M1 1AE</p></body></html>');
    expect(loc.country).toBe('GB');
    expect(loc.city).toContain('Manchester');
  });

  it('carries the inferred country into the JobPostDto location built from locationRaw', () => {
    const location = build({ locationRaw: 'Miami, FL 33101' });
    expect(location).toMatchObject({ city: 'Miami', state: 'FL', country: 'US' });
  });

  it.each(['false', '0', 'off', 'No'])('=%s keeps the shared parser literal-only country', (value) => {
    process.env.HARRI_LOCATION_HEURISTICS = value;
    expect(parseAddress('San Jose, CA 95130').country).toBeNull();
    expect(extract('<p>Manchester, M1 1AE</p>').country).toBeNull();
    expect(build({ locationRaw: 'Miami, FL 33101' })?.country).toBeNull();
  });

  it('harriLocationHeuristicsEnabled defaults to on', () => {
    expect(harriLocationHeuristicsEnabled({})).toBe(true);
    expect(harriLocationHeuristicsEnabled({ HARRI_LOCATION_HEURISTICS: 'true' })).toBe(true);
    expect(harriLocationHeuristicsEnabled({ HARRI_LOCATION_HEURISTICS: ' OFF ' })).toBe(false);
  });
});

/** Best of three wall-clock runs, in ms (one run can overshoot on a throttled pod). */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('HarriService scraped-text regexes stay linear (Spec 1689)', () => {
  type Internals = { parseAddressString(raw: string): { city: string | null; state: string | null } };
  const parse = (raw: string) => (new HarriService() as unknown as Internals).parseAddressString(raw);

  it('still pulls a "City, ST ZIP" address out of prose', () => {
    expect(parse('Visit 1030 El Paseo, San Jose, CA 95130 today')).toMatchObject({
      city: 'San Jose',
      state: 'CA',
    });
  });

  it('scans 55 KB of unpunctuated prose in linear time (was 4.2 s)', () => {
    const prose = 'lorem ipsum dolor sit amet '.repeat(2_100);
    expect(prose.length).toBeGreaterThan(55_000);
    expect(bestOf3Ms(() => parse(prose))).toBeLessThan(100);
  });
});
