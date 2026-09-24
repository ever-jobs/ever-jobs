import { Country, JobPostDto, LocationDto } from '@ever-jobs/models';
import { canonicalJobId, dedupKeyForJob, formatJobLocation } from '@ever-jobs/common';

/**
 * Spec 1721 / contract C9 — `dedupKey`: the same posting seen through
 * different sources, or on different runs, must get the same key.
 */
describe('dedupKeyForJob (Spec 1721)', () => {
  const board = new JobPostDto({
    id: 'li-123',
    site: 'linkedin',
    title: 'Senior Software Engineer',
    companyName: 'Acme, Inc.',
    jobUrl: 'https://www.linkedin.com/jobs/view/123',
    location: new LocationDto({ city: 'New York', state: 'NY', country: Country.USA }),
  });

  it('is identical for the same posting from two different sources', () => {
    // Same role, surfaced by the company's ATS: different site, id, URL,
    // title abbreviation/case, legal suffix and punctuation.
    const ats = new JobPostDto({
      id: 'gh-9f8e7d',
      site: 'greenhouse',
      title: 'Sr. Software Engineer',
      companyName: 'ACME INC',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/9f8e7d',
      location: new LocationDto({ city: 'new york', state: 'ny', country: Country.USA }),
    });
    const a = dedupKeyForJob(board);
    const b = dedupKeyForJob(ats);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('is stable across runs (pure function of the posting)', () => {
    const again = new JobPostDto({ ...board, id: 'li-999', datePosted: '2030-01-01' });
    expect(dedupKeyForJob(again)).toBe(dedupKeyForJob(board));
  });

  it('equals the dedup engine canonicalJobId for the same fields', () => {
    expect(dedupKeyForJob(board)).toBe(
      canonicalJobId({
        title: board.title,
        company: board.companyName,
        location: formatJobLocation(board.location),
      }),
    );
  });

  it('is the same whether the location is a LocationDto or a cache-round-tripped plain object', () => {
    const roundTripped = JSON.parse(JSON.stringify(board)) as JobPostDto;
    expect(typeof (roundTripped.location as { displayLocation?: unknown }).displayLocation).toBe('undefined');
    expect(dedupKeyForJob(roundTripped)).toBe(dedupKeyForJob(board));
  });

  it('differs for a different title, company or location', () => {
    const base = dedupKeyForJob(board);
    expect(dedupKeyForJob({ ...board, title: 'Staff Software Engineer' })).not.toBe(base);
    expect(dedupKeyForJob({ ...board, companyName: 'Globex' })).not.toBe(base);
    expect(
      dedupKeyForJob({ ...board, location: new LocationDto({ city: 'Boston', state: 'MA', country: Country.USA }) }),
    ).not.toBe(base);
  });

  it('handles a missing location', () => {
    const noLoc = dedupKeyForJob({ title: 'Engineer', companyName: 'Acme' });
    expect(noLoc).toBe(canonicalJobId({ title: 'Engineer', company: 'Acme', location: '' }));
  });

  it('returns undefined when there is neither a title nor a company', () => {
    expect(dedupKeyForJob({ title: '', companyName: '  ' })).toBeUndefined();
    expect(dedupKeyForJob({ title: null, companyName: null })).toBeUndefined();
  });
});

describe('formatJobLocation (Spec 1721)', () => {
  it('uses displayLocation() when available and matches the plain-object rendering', () => {
    const dto = new LocationDto({ city: 'Paris', state: 'IDF', country: Country.FRANCE });
    const plain = { city: 'Paris', state: 'IDF', country: 'FRANCE' };
    expect(formatJobLocation(dto)).toBe('Paris, IDF, FRANCE');
    expect(formatJobLocation(plain)).toBe(formatJobLocation(dto));
  });

  it('renders null / undefined as an empty string', () => {
    expect(formatJobLocation(null)).toBe('');
    expect(formatJobLocation(undefined)).toBe('');
  });
});
