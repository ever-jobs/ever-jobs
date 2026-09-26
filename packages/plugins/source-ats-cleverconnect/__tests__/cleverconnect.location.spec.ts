/**
 * Spec 1689 (fork-sync hardening) — CleverConnect "City (dept) - Region" localities.
 *
 * Spec 5125 swapped CleverConnect's locality split for the shared parser, which
 * keeps only the city of "Guebwiller (68) - Grand Est" and drops the region.
 * The pre-5125 split is restored on top of the shared parser (default on);
 * CLEVERCONNECT_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { CleverConnectService } from '../src/cleverconnect.service';
import { cleverConnectLocationHeuristicsEnabled } from '../src/cleverconnect.constants';

describe('CleverConnectService location heuristics (CLEVERCONNECT_LOCATION_HEURISTICS)', () => {
  const saved = process.env.CLEVERCONNECT_LOCATION_HEURISTICS;
  let service: CleverConnectService;
  const split = (label: string) => (service as any).splitLocation(label);
  const toPost = (locality: string) =>
    (service as any).processJob(
      (service as any).normaliseJob({ id: '4242', title: 'Technicien', locality }, 'acme'),
      'acme',
    );

  beforeEach(() => {
    delete process.env.CLEVERCONNECT_LOCATION_HEURISTICS;
    service = new CleverConnectService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.CLEVERCONNECT_LOCATION_HEURISTICS;
    else process.env.CLEVERCONNECT_LOCATION_HEURISTICS = saved;
  });

  it.each([
    ['Guebwiller (68) - Grand Est', { city: 'Guebwiller', state: 'Grand Est', country: null }],
    ['Issy-les-Moulineaux (92) - Île-de-France', { city: 'Issy-les-Moulineaux', state: 'Île-de-France', country: null }],
    ['Lyon (69) – Auvergne-Rhône-Alpes, France', { city: 'Lyon', state: 'Auvergne-Rhône-Alpes', country: 'France' }],
  ])('splits "%s" into city / region / country by default', (label, expected) => {
    expect(split(label)).toEqual(expected);
  });

  it('leaves labels without a spaced dash to the shared parser', () => {
    expect(split('Nantes (44)')).toMatchObject({ city: 'Nantes', state: null });
    expect(split('Remote')).toEqual({ city: null, state: null, country: null });
  });

  it('carries the region onto the JobPostDto location', () => {
    const post = toPost('Guebwiller (68) - Grand Est');
    expect(post.location).toMatchObject({ city: 'Guebwiller', state: 'Grand Est' });
    expect(post.locations).toEqual([post.location]);
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
    process.env.CLEVERCONNECT_LOCATION_HEURISTICS = value;
    expect(split('Guebwiller (68) - Grand Est').state).not.toBe('Grand Est');
  });

  it('cleverConnectLocationHeuristicsEnabled defaults to on', () => {
    expect(cleverConnectLocationHeuristicsEnabled({})).toBe(true);
    expect(cleverConnectLocationHeuristicsEnabled({ CLEVERCONNECT_LOCATION_HEURISTICS: 'false' })).toBe(false);
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

describe('CleverConnectService scraped-text regexes stay linear (Spec 1689)', () => {
  const split = (text: string) =>
    (new CleverConnectService() as unknown as { splitDashLocality(t: string): unknown }).splitDashLocality(
      text,
    );

  it('keeps the documented "City (dept) - Region" split', () => {
    expect(split('Paris (75) - Île-de-France, France')).toMatchObject({
      city: 'Paris',
      state: 'Île-de-France',
    });
  });

  it.each([
    ['a whitespace run before a paren', `Paris${' '.repeat(20_000)}(75) - IDF`],
    ['a whitespace run without a paren', `Paris${' '.repeat(20_000)}x - IDF`],
    ['unclosed parens', `${'('.repeat(20_000)} - IDF`],
  ])('splits a 20k-char locality with %s in linear time', (_name, text) => {
    expect(bestOf3Ms(() => split(text))).toBeLessThan(50);
  });
});
