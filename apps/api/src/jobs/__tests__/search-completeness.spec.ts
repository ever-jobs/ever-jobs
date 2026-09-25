import type { ScrapeReason } from '@ever-jobs/models';
import {
  COMPLETE_SEARCH,
  buildSearchCompleteness,
  isFailedSourceReason,
  isSearchCompleteness,
} from '../search-completeness';

/** Spec 1721 / FR-15 — the crawl-completeness record and its cache guard. */
describe('search-completeness (Spec 1721 / FR-15)', () => {
  const rows = (...reasons: ScrapeReason[]) => reasons.map((reason) => ({ reason }));

  describe('isFailedSourceReason', () => {
    it.each<[ScrapeReason, boolean]>([
      ['ok', false],
      ['empty', false],
      ['partial', false],
      ['blocked', true],
      ['browser_unavailable', true],
      ['fetch_error', true],
      ['timeout', true],
      ['bad_input', true],
      ['circuit_open', true],
      ['not_registered', true],
      ['unknown', true],
    ])('%s → failed=%s', (reason, failed) => {
      expect(isFailedSourceReason(reason)).toBe(failed);
    });
  });

  describe('buildSearchCompleteness', () => {
    it('no stop reason → complete, failures counted from the rows', () => {
      expect(buildSearchCompleteness(null, 0, rows('ok', 'empty', 'partial', 'blocked', 'timeout'))).toEqual({
        complete: true,
        stopReason: null,
        sourcesSkipped: 0,
        sourcesFailed: 2,
      });
    });

    it.each(['deadline', 'job_ceiling'] as const)('stop reason %s → incomplete', (reason) => {
      expect(buildSearchCompleteness(reason, 7, rows('ok', 'fetch_error'))).toEqual({
        complete: false,
        stopReason: reason,
        sourcesSkipped: 7,
        sourcesFailed: 1,
      });
    });

    it('no rows → no failures', () => {
      expect(buildSearchCompleteness(null, 0, [])).toEqual(COMPLETE_SEARCH);
    });
  });

  describe('isSearchCompleteness (cache read-back guard)', () => {
    it.each([
      ['complete', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 3 }],
      ['deadline', { complete: false, stopReason: 'deadline', sourcesSkipped: 12, sourcesFailed: 0 }],
      ['job ceiling', { complete: false, stopReason: 'job_ceiling', sourcesSkipped: 1, sourcesFailed: 1 }],
      ['extra fields from a newer version', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, x: 1 }],
    ])('accepts %s', (_label, value) => {
      expect(isSearchCompleteness(value)).toBe(true);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a legacy raw job array (the other cache entry)', [{ id: 'job-1' }]],
      ['a string', 'complete'],
      ['complete without stopReason null', { complete: true, stopReason: 'deadline', sourcesSkipped: 0, sourcesFailed: 0 }],
      ['incomplete with a null stopReason', { complete: false, stopReason: null, sourcesSkipped: 1, sourcesFailed: 0 }],
      ['an unknown stopReason', { complete: false, stopReason: 'cancelled', sourcesSkipped: 1, sourcesFailed: 0 }],
      ['a negative count', { complete: true, stopReason: null, sourcesSkipped: -1, sourcesFailed: 0 }],
      ['a fractional count', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0.5 }],
      ['a string count', { complete: true, stopReason: null, sourcesSkipped: '0', sourcesFailed: 0 }],
      ['a missing count', { complete: true, stopReason: null, sourcesSkipped: 0 }],
      ['complete as a string', { complete: 'true', stopReason: null, sourcesSkipped: 0, sourcesFailed: 0 }],
    ])('rejects %s', (_label, value) => {
      expect(isSearchCompleteness(value)).toBe(false);
    });
  });

  it('COMPLETE_SEARCH is frozen (callers spread it, never mutate the shared value)', () => {
    expect(Object.isFrozen(COMPLETE_SEARCH)).toBe(true);
    expect(isSearchCompleteness(COMPLETE_SEARCH)).toBe(true);
  });
});
