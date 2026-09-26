/**
 * Spec 1689 (fork-sync hardening) — Jobsoid "City - State" labels.
 *
 * Spec 5125 swapped Jobsoid's `/[-,]/` split for the shared parser, which keeps
 * only the city of "Pune - Maharashtra" and drops the region. The region is
 * restored on top of the shared parser (default on);
 * JOBSOID_LOCATION_HEURISTICS=false turns it off.
 */
import 'reflect-metadata';
import { JobsoidService } from '../src/jobsoid.service';
import { jobsoidLocationHeuristicsEnabled } from '../src/jobsoid.constants';

describe('JobsoidService location heuristics (JOBSOID_LOCATION_HEURISTICS)', () => {
  const saved = process.env.JOBSOID_LOCATION_HEURISTICS;
  let service: JobsoidService;
  const fromTitle = (title: string) => (service as any).extractLocation({ location: { title } });

  beforeEach(() => {
    delete process.env.JOBSOID_LOCATION_HEURISTICS;
    service = new JobsoidService();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.JOBSOID_LOCATION_HEURISTICS;
    else process.env.JOBSOID_LOCATION_HEURISTICS = saved;
  });

  it.each([
    ['Pune - Maharashtra', 'Pune', 'Maharashtra'],
    ['Milan - Milan', 'Milan', 'Milan'],
    ['Austin - TX', 'Austin', 'TX'],
  ])('keeps the region of "%s" as the state by default', (label, city, state) => {
    expect(fromTitle(label)).toMatchObject({ city, state });
  });

  it('keeps the country the shared parser found', () => {
    expect(fromTitle('Pune - Maharashtra, India')).toMatchObject({
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
    });
  });

  it('does not split hyphenated city names or workplace heads', () => {
    expect(fromTitle('Aix-en-Provence')?.city).toBe('Aix-en-Provence');
    expect(fromTitle('Remote - US')?.city).not.toBe('Remote');
  });

  it('prefers the structured location block when present', () => {
    const location = (service as any).extractLocation({ location: { city: 'Lyon', country: 'France', title: 'X - Y' } });
    expect(location).toMatchObject({ city: 'Lyon', country: 'France' });
  });

  it.each(['false', '0', 'off', 'no'])('=%s returns the shared-parser output only', (value) => {
    process.env.JOBSOID_LOCATION_HEURISTICS = value;
    expect(fromTitle('Pune - Maharashtra')?.state).toBeUndefined();
  });

  it('jobsoidLocationHeuristicsEnabled defaults to on', () => {
    expect(jobsoidLocationHeuristicsEnabled({})).toBe(true);
    expect(jobsoidLocationHeuristicsEnabled({ JOBSOID_LOCATION_HEURISTICS: 'false' })).toBe(false);
  });
});
