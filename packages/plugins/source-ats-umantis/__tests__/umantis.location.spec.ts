/**
 * Spec 1689 (fork-sync hardening) — Umantis "City (Country)" labels.
 *
 * Spec 5125 swapped Umantis' positional split for the shared parser, which
 * folds the parenthesised country into the city ("Munich (Germany)" → city
 * "Munich Germany"). The pre-5125 rule is restored on top of the shared parser
 * (default on); UMANTIS_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { UmantisService } from '../src/umantis.service';
import { umantisLocationHeuristicsEnabled } from '../src/umantis.constants';

describe('UmantisService location heuristics (UMANTIS_LOCATION_HEURISTICS)', () => {
  const saved = process.env.UMANTIS_LOCATION_HEURISTICS;
  let service: UmantisService;
  const split = (label: string) => (service as any).splitLocation(label);
  const toPost = (location: string) =>
    (service as any).processJob(
      (service as any).normaliseJob(
        { id: '1410', url: 'https://recruitingapp-1234.umantis.com/Vacancies/1410/Description/1', title: 'Engineer', location },
        null,
        '1234',
      ),
      '1234',
    );

  beforeEach(() => {
    delete process.env.UMANTIS_LOCATION_HEURISTICS;
    service = new UmantisService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.UMANTIS_LOCATION_HEURISTICS;
    else process.env.UMANTIS_LOCATION_HEURISTICS = saved;
  });

  it('maps "City (Country)" to city + country by default', () => {
    expect(split('Munich (Germany)')).toEqual({ city: 'Munich', state: null, country: 'Germany' });
  });

  it('normalises a recognisable country code and keeps an unknown token verbatim', () => {
    expect(split('Zug (CH)').country).toBe('Switzerland');
    expect(split('Wien (Österreich)')).toEqual({ city: 'Wien', state: null, country: 'Österreich' });
  });

  it('leaves workplace / numeric parentheticals to the shared parser', () => {
    expect(split('Zürich (Hybrid)').country).toBeNull();
    expect(split('Bern (80%)').country).toBeNull();
  });

  it('leaves plain labels to the shared parser', () => {
    expect(split('Regensburg')).toMatchObject({ city: 'Regensburg' });
  });

  it('carries the country onto the JobPostDto location', () => {
    const post = toPost('Munich (Germany)');
    expect(post.location).toMatchObject({ city: 'Munich', country: 'Germany' });
    expect(post.locations).toEqual([post.location]);
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
    process.env.UMANTIS_LOCATION_HEURISTICS = value;
    expect(split('Munich (Germany)').city).toMatch(/Germany/);
  });

  it('umantisLocationHeuristicsEnabled defaults to on', () => {
    expect(umantisLocationHeuristicsEnabled({})).toBe(true);
    expect(umantisLocationHeuristicsEnabled({ UMANTIS_LOCATION_HEURISTICS: 'no' })).toBe(false);
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

describe('UmantisService scraped-text regexes stay linear (Spec 1689)', () => {
  type Internals = {
    cityWithParenCountry(text: string): { city: string | null; country: string | null } | null;
    cleanText(v: string): string | null;
  };
  const svc = () => new UmantisService() as unknown as Internals;

  it('matches the former /^([^()]+?)\\s*\\(([^()]+)\\)\\s*$/ split on 3,000 fuzz labels', () => {
    const { normalizeCountryOnly } = jest.requireActual('@ever-jobs/common');
    // the pre-rewrite method body, verbatim, as the oracle
    const legacy = (text: string) => {
      const service = svc();
      const paren = /^([^()]+?)\s*\(([^()]+)\)\s*$/.exec(text);
      if (!paren) return null;
      const city = service.cleanText(paren[1]);
      const token = service.cleanText(paren[2]);
      if (!city || !token || city.includes(',')) return null;
      if (/\d/.test(token) || /\b(?:remote|hybrid|on-?site|office|home|homeoffice)\b/i.test(token)) return null;
      return { city, state: null, country: normalizeCountryOnly(token) ?? token };
    };
    const alphabet = [
      'Munich', ' ', '  ', '(', ')', 'Germany', 'CH', ',', 'a', '\t', '80%', 'Hybrid',
      'Zurich (CH)', ' (Germany) ', '(Hybrid)',
    ];
    let seed = 1689;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const n = 1 + Math.floor(next() * 8);
      for (let t = 0; t < n; t++) text += alphabet[Math.floor(next() * alphabet.length)];
      const expected = legacy(text);
      if (expected) hits++;
      expect([text, svc().cityWithParenCountry(text)]).toEqual([text, expected]);
    }
    expect(hits).toBeGreaterThan(20);
  });

  it.each([
    ['a whitespace run without a paren', `Munich${' '.repeat(20_000)}x`],
    ['a whitespace run before a paren', `Munich${' '.repeat(20_000)}(Germany)`],
    ['unclosed parens', `Munich ${'('.repeat(20_000)}`],
  ])('splits a 20k-char label with %s in linear time', (_name, text) => {
    expect(bestOf3Ms(() => svc().cityWithParenCountry(text))).toBeLessThan(50);
  });
});
