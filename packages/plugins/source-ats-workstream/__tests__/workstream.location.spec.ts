/**
 * Spec 1689 (fork-sync hardening) — Workstream US country inference.
 *
 * Spec 5125 routed Workstream's address parsing through the shared parser and
 * dropped the `US` stamp the "City, ST ZIP" address shape implied. It is
 * restored on top of the shared parser (default on) and can be switched off
 * with WORKSTREAM_LOCATION_HEURISTICS=false.
 */
import 'reflect-metadata';
import { WorkstreamService } from '../src/workstream.service';
import { workstreamLocationHeuristicsEnabled } from '../src/workstream.constants';

type Loc = { city: string | null; state: string | null; country: string | null; raw?: string | null };

describe('WorkstreamService location heuristics (WORKSTREAM_LOCATION_HEURISTICS)', () => {
  const saved = process.env.WORKSTREAM_LOCATION_HEURISTICS;
  let service: WorkstreamService;
  const parseAddress = (raw: string): Loc => (service as any).parseAddressString(raw);
  const extract = (html: string): Loc => (service as any).extractLocation(html);

  beforeEach(() => {
    delete process.env.WORKSTREAM_LOCATION_HEURISTICS;
    service = new WorkstreamService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.WORKSTREAM_LOCATION_HEURISTICS;
    else process.env.WORKSTREAM_LOCATION_HEURISTICS = saved;
  });

  it('stamps US on a US address shape by default', () => {
    expect(parseAddress('San Jose, CA 95130')).toMatchObject({ city: 'San Jose', state: 'CA', country: 'US' });
  });

  it('stamps US on the "City, ST 12345" HTML fallback', () => {
    const loc = extract('<html><body><p>Location: Austin, TX 78701</p></body></html>');
    expect(loc).toMatchObject({ state: 'TX', country: 'US' });
  });

  it('stamps US through the og:description meta path', () => {
    const loc = extract('<html><head><meta property="og:description" content="Crew member in Denver, CO 80202"></head></html>');
    expect(loc).toMatchObject({ state: 'CO', country: 'US' });
  });

  it('does not stamp US when the 2-letter token is not a US state', () => {
    expect(parseAddress('Toronto, ON').country).toBeNull();
  });

  it('keeps a country the shared parser found for a non-address label', () => {
    expect(parseAddress('Dublin, Ireland').country).toBe('Ireland');
  });

  it.each(['false', '0', 'off', 'no'])('=%s keeps the shared parser literal-only country', (value) => {
    process.env.WORKSTREAM_LOCATION_HEURISTICS = value;
    expect(parseAddress('San Jose, CA 95130').country).toBeNull();
    expect(extract('<p>Austin, TX 78701</p>').country).toBeNull();
  });

  it('workstreamLocationHeuristicsEnabled defaults to on', () => {
    expect(workstreamLocationHeuristicsEnabled({})).toBe(true);
    expect(workstreamLocationHeuristicsEnabled({ WORKSTREAM_LOCATION_HEURISTICS: 'FALSE' })).toBe(false);
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

describe('WorkstreamService scraped-text regexes stay linear (Spec 1689)', () => {
  type Internals = {
    extractLocation(html: string): { city: string | null; state: string | null; raw: string | null };
    parseAddressString(raw: string): { city: string | null; state: string | null };
  };
  const svc = () => new WorkstreamService() as unknown as Internals;
  const prose = 'lorem ipsum dolor sit amet '.repeat(4_100);

  it('still finds a "City, ST ZIP" address in the page', () => {
    const loc = svc().extractLocation(`<p>Store: Austin, TX 78701</p>`);
    expect(loc).toMatchObject({ city: 'Austin', state: 'TX' });
  });

  it('scans 110 KB of unpunctuated prose in linear time (was 21.8 s)', () => {
    const html = `<p>${prose}</p>`;
    expect(html.length).toBeGreaterThan(110_000);
    expect(bestOf3Ms(() => svc().extractLocation(html))).toBeLessThan(100);
    expect(bestOf3Ms(() => svc().parseAddressString(prose))).toBeLessThan(100);
  });
});
