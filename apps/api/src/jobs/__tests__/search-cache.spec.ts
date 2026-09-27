import { JobPostDto } from '@ever-jobs/models';
import { COMPLETE_SEARCH } from '../search-completeness';
import { SEARCH_CACHE_ENDPOINT, readCachedSearch, toCachedSearch } from '../search-cache';

/** Spec 1721 / FR-19 — one cache entry for the raw set and its completeness record. */
describe('search-cache (Spec 1721 / FR-19)', () => {
  const jobs = [new JobPostDto({ id: 'a', title: 'Engineer', jobUrl: 'https://example.com/a' })];

  it('has its own namespace, so entries of the old two-entry layout are never read', () => {
    expect(SEARCH_CACHE_ENDPOINT).toBe('search-v2');
    expect(['search', 'search-completeness']).not.toContain(SEARCH_CACHE_ENDPOINT);
  });

  it('round-trips the set and the record through one value (as Redis would, via JSON)', () => {
    const value = JSON.parse(JSON.stringify(toCachedSearch(jobs, { ...COMPLETE_SEARCH })));
    const back = readCachedSearch(value);
    expect(back?.jobs.map((j) => j.id)).toEqual(['a']);
    expect(back?.completeness).toEqual(COMPLETE_SEARCH);
  });

  it('omits an unknown record instead of guessing one', () => {
    expect(toCachedSearch(jobs, undefined)).toEqual({ jobs });
    expect(readCachedSearch({ jobs })).toEqual({ jobs });
  });

  it('drops a malformed record but keeps the set (JSON can still serve it)', () => {
    const back = readCachedSearch({ jobs, completeness: { complete: false, stopReason: 'cancelled' } });
    expect(back).toEqual({ jobs });
  });

  it('reads a bare job array as a set without a record', () => {
    expect(readCachedSearch(jobs)).toEqual({ jobs });
  });

  it.each([null, undefined, 'x', 42, {}, { jobs: 'nope' }])('rejects %p', (value) => {
    expect(readCachedSearch(value)).toBeNull();
  });
});
