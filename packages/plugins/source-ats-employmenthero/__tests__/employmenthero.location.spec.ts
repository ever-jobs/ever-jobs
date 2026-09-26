/**
 * Spec 1689 (fork-sync hardening) — Employment Hero postcode stripping.
 *
 * Spec 5125 swapped Employment Hero's positional split for the shared parser,
 * which keeps the postcode inside the region ("Sydney, NSW 2000" → state
 * "NSW 2000"). The pre-5125 stripping is restored on top of the shared parser
 * (default on); EMPLOYMENTHERO_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { EmploymentHeroService } from '../src/employmenthero.service';
import { employmentHeroLocationHeuristicsEnabled } from '../src/employmenthero.constants';

describe('EmploymentHeroService location heuristics (EMPLOYMENTHERO_LOCATION_HEURISTICS)', () => {
  const saved = process.env.EMPLOYMENTHERO_LOCATION_HEURISTICS;
  let service: EmploymentHeroService;
  const split = (label: string) => (service as any).splitLocation(label);
  const toPost = (vendorLocation: string) =>
    (service as any).processItem(
      {
        id: 'abc-1',
        friendly_id: 'barista-abc-1',
        title: 'Barista',
        vendor_location_name: vendorLocation,
        country_code: 'AU',
      },
      'acme',
      'Acme',
      undefined,
      new Set<string>(),
    );

  beforeEach(() => {
    delete process.env.EMPLOYMENTHERO_LOCATION_HEURISTICS;
    service = new EmploymentHeroService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.EMPLOYMENTHERO_LOCATION_HEURISTICS;
    else process.env.EMPLOYMENTHERO_LOCATION_HEURISTICS = saved;
  });

  it.each([
    ['Sydney, NSW 2000', 'Sydney', 'NSW'],
    ['Melbourne, VIC 3000', 'Melbourne', 'VIC'],
    ['Greater London, SouthEast E1', 'Greater London', 'SouthEast'],
  ])('strips the postcode from "%s" by default', (label, city, state) => {
    expect(split(label)).toEqual({ city, state });
  });

  it('never clips a region word without a digit', () => {
    expect(split('Sydney, New South Wales').state).toBe('New South Wales');
  });

  it('keeps a region that is nothing but a postcode', () => {
    expect(split('London, SW1A 1AA').state).toBe('SW1A 1AA');
  });

  it('carries the stripped region onto the JobPostDto location', () => {
    const post = toPost('Sydney, NSW 2000');
    expect(post.location).toMatchObject({ city: 'Sydney', state: 'NSW', country: 'AU' });
    expect(post.locations).toEqual([post.location]);
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser region unchanged', (value) => {
    process.env.EMPLOYMENTHERO_LOCATION_HEURISTICS = value;
    expect(split('Sydney, NSW 2000').state).toMatch(/2000/);
  });

  it('employmentHeroLocationHeuristicsEnabled defaults to on', () => {
    expect(employmentHeroLocationHeuristicsEnabled({})).toBe(true);
    expect(employmentHeroLocationHeuristicsEnabled({ EMPLOYMENTHERO_LOCATION_HEURISTICS: '0' })).toBe(false);
  });
});
