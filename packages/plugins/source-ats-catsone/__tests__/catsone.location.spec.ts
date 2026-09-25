/**
 * Spec 1689 (fork-sync hardening) — CATS parenthetical stripping.
 *
 * Spec 5125 swapped CATS' positional parser for the shared parser, which keeps
 * non-workplace parentheticals inline ("Leeds (Head Office), UK" → city
 * "Leeds Head Office"). The pre-5125 stripping is restored on top of the shared
 * parser (default on); CATSONE_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { CatsoneService } from '../src/catsone.service';
import { catsoneLocationHeuristicsEnabled } from '../src/catsone.constants';

describe('CatsoneService location heuristics (CATSONE_LOCATION_HEURISTICS)', () => {
  const saved = process.env.CATSONE_LOCATION_HEURISTICS;
  let service: CatsoneService;
  const parse = (label: string) => (service as any).parseLocation(label);
  const toPost = (location: string | null) =>
    (service as any).processJob(
      {
        atsId: '16818533',
        title: 'Java Developer',
        jobUrl: 'https://acme.catsone.com/careers/1-General/jobs/16818533',
        location,
        category: 'Engineering',
        descriptionHtml: null,
      },
      'Acme',
    );

  beforeEach(() => {
    delete process.env.CATSONE_LOCATION_HEURISTICS;
    service = new CatsoneService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.CATSONE_LOCATION_HEURISTICS;
    else process.env.CATSONE_LOCATION_HEURISTICS = saved;
  });

  it('strips a parenthetical qualifier out of the city by default', () => {
    const location = parse('Leeds (Head Office), UK');
    expect(location?.city).toBe('Leeds');
    expect(location?.country).toBeTruthy();
    expect(location?.city).not.toMatch(/Head Office/);
  });

  it('strips a workplace parenthetical ("Manchester (Hybrid), UK")', () => {
    expect(parse('Manchester (Hybrid), UK')?.city).toBe('Manchester');
  });

  it('falls back to the full label when the parenthetical is the geography', () => {
    const location = parse('Remote (Paris, FR)');
    expect(location?.city).toBe('Paris');
  });

  it('leaves labels without parentheticals to the shared parser', () => {
    expect(parse('Austin, TX')).toMatchObject({ city: 'Austin', state: 'TX' });
  });

  it('emits the stripped location on the JobPostDto (location and locations[])', () => {
    const post = toPost('Leeds (Head Office), UK');
    expect(post.location.city).toBe('Leeds');
    expect(post.locations).toEqual([post.location]);
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
    process.env.CATSONE_LOCATION_HEURISTICS = value;
    expect(parse('Leeds (Head Office), UK')?.city).toMatch(/Head Office/);
  });

  it('catsoneLocationHeuristicsEnabled defaults to on', () => {
    expect(catsoneLocationHeuristicsEnabled({})).toBe(true);
    expect(catsoneLocationHeuristicsEnabled({ CATSONE_LOCATION_HEURISTICS: 'Off' })).toBe(false);
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

describe('CatsoneService scraped-text regexes stay linear (Spec 1689)', () => {
  const parse = (label: string) =>
    (new CatsoneService() as unknown as { parseLocation(l: string): unknown }).parseLocation(label);

  it.each([
    ['a whitespace run before a paren', `Leeds${' '.repeat(20_000)}(Head Office), UK`],
    ['a whitespace run without a paren', `Leeds${' '.repeat(20_000)}x`],
    ['unclosed parens', '('.repeat(20_000)],
  ])('strips a 20k-char label with %s in linear time', (_name, label) => {
    expect(bestOf3Ms(() => parse(label))).toBeLessThan(50);
  });
});
