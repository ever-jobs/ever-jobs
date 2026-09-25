/**
 * Spec 1689 (fork-sync hardening) — Amazon US country inference.
 *
 * Spec 5125 swapped Amazon's positional split (`country: parts[2] ?? 'US'`)
 * for the shared parser and removed the `US` default. It is restored on top of
 * the shared parser for evidently-US labels (default on);
 * AMAZON_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { AmazonService } from '../src/amazon.service';
import { amazonLocationHeuristicsEnabled } from '../src/amazon.constants';

describe('AmazonService location heuristics (AMAZON_LOCATION_HEURISTICS)', () => {
  const saved = process.env.AMAZON_LOCATION_HEURISTICS;
  let service: AmazonService;
  const toPost = (location?: string) =>
    (service as any).mapToJobPost({
      fields: {
        title: ['Software Development Engineer'],
        urlNextStep: ['https://www.amazon.jobs/en/jobs/1234567'],
        ...(location ? { location: [location] } : {}),
      },
    });

  beforeEach(() => {
    delete process.env.AMAZON_LOCATION_HEURISTICS;
    service = new AmazonService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.AMAZON_LOCATION_HEURISTICS;
    else process.env.AMAZON_LOCATION_HEURISTICS = saved;
  });

  it('fills US for a label with a US state and no country by default', () => {
    const post = toPost('Seattle, WA');
    expect(post.location).toMatchObject({ city: 'Seattle', state: 'WA', country: 'US' });
    expect(post.locations).toEqual([post.location]);
  });

  it('keeps a country the shared parser found', () => {
    expect(toPost('Seattle, WA, USA').location.country).toBe('United States');
    expect(toPost('London, GBR').location.country).toBe('United Kingdom');
  });

  it('does not mislabel a non-US state code as US', () => {
    expect(toPost('Bangalore, KA').location.country).toBeUndefined();
  });

  it('emits no location for a hit without one', () => {
    expect(toPost().location).toBeNull();
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
    process.env.AMAZON_LOCATION_HEURISTICS = value;
    expect(toPost('Seattle, WA').location.country).toBeUndefined();
  });

  it('amazonLocationHeuristicsEnabled defaults to on', () => {
    expect(amazonLocationHeuristicsEnabled({})).toBe(true);
    expect(amazonLocationHeuristicsEnabled({ AMAZON_LOCATION_HEURISTICS: 'off' })).toBe(false);
  });
});
