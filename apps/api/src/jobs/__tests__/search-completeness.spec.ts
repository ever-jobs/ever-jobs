import { Site } from '@ever-jobs/models';
import type { ScrapeReason } from '@ever-jobs/models';
import {
  COMPLETE_SEARCH,
  MAX_PROBLEM_SOURCES,
  ProblemSource,
  buildSearchCompleteness,
  isFailedSourceReason,
  isSearchCompleteness,
  problemOfRanSource,
} from '../search-completeness';

/** Spec 1721 / FR-15, FR-20 — the crawl-completeness record and its cache guard. */
describe('search-completeness (Spec 1721 / FR-15, FR-20)', () => {
  const rows = (...reasons: ScrapeReason[]) => reasons.map((reason) => ({ reason }));
  /** FR-20 fields of a record with no problem sources. */
  const clean = { sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 };

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

  describe('problemOfRanSource (FR-20)', () => {
    const row = (reason: ScrapeReason, count: number) => ({ site: 'acme', reason, count });

    it.each<[ScrapeReason, number, ProblemSource | null]>([
      ['ok', 3, null],
      ['empty', 0, null],
      ['partial', 4, { site: 'acme', reason: 'partial' }],
      ['blocked', 0, { site: 'acme', reason: 'blocked' }],
      ['timeout', 0, { site: 'acme', reason: 'timeout' }],
      ['ok', 10, { site: 'acme', reason: 'results_wanted' }],
      ['ok', 12, { site: 'acme', reason: 'results_wanted' }],
      ['partial', 10, { site: 'acme', reason: 'partial' }],
    ])('%s with %d jobs (resultsWanted 10) → %p', (reason, count, expected) => {
      expect(problemOfRanSource(row(reason, count), 10)).toEqual(expected);
    });

    it('never reports results_wanted without a positive resultsWanted', () => {
      expect(problemOfRanSource(row('ok', 50), undefined)).toBeNull();
      expect(problemOfRanSource(row('ok', 50), 0)).toBeNull();
    });
  });

  describe('buildSearchCompleteness', () => {
    it('no stop reason → complete, failures and partials counted from the rows', () => {
      expect(buildSearchCompleteness(null, 0, rows('ok', 'empty', 'partial', 'blocked', 'timeout'))).toEqual({
        complete: true,
        stopReason: null,
        sourcesSkipped: 0,
        sourcesFailed: 2,
        ...clean,
        sourcesPartial: 1,
      });
    });

    it.each(['deadline', 'job_ceiling'] as const)('stop reason %s → incomplete', (reason) => {
      expect(buildSearchCompleteness(reason, 7, rows('ok', 'fetch_error'))).toEqual({
        complete: false,
        stopReason: reason,
        sourcesSkipped: 7,
        sourcesFailed: 1,
        ...clean,
      });
    });

    it('no rows → no failures', () => {
      expect(buildSearchCompleteness(null, 0, [])).toEqual(COMPLETE_SEARCH);
    });

    it(`lists problem sources in order, capped at ${MAX_PROBLEM_SOURCES}, and reports the uncapped total`, () => {
      const problems: ProblemSource[] = Array.from({ length: MAX_PROBLEM_SOURCES + 5 }, (_, i) => ({
        site: `s${i}`,
        reason: i % 2 ? 'skipped' : 'blocked',
      }));
      const record = buildSearchCompleteness('deadline', 3, rows('blocked'), problems);
      expect(record.problemSources).toHaveLength(MAX_PROBLEM_SOURCES);
      expect(record.problemSources[0]).toEqual({ site: 's0', reason: 'blocked' });
      expect(record.problemSources[1]).toEqual({ site: 's1', reason: 'skipped' });
      expect(record.problemSourcesTotal).toBe(MAX_PROBLEM_SOURCES + 5);
      expect(isSearchCompleteness(record)).toBe(true);
    });
  });

  describe('the problemSources cap fits a catalogue-wide crawl (FR-21)', () => {
    /** Every registered source — the most a crawl can select, each at most once. */
    const catalogue = Object.values(Site) as string[];

    it('is at least the number of registered sources', () => {
      // Red when the catalogue outgrows the cap: raise MAX_PROBLEM_SOURCES then.
      expect(catalogue.length).toBeGreaterThan(1000);
      expect(MAX_PROBLEM_SOURCES).toBeGreaterThanOrEqual(catalogue.length);
    });

    it('carries a problem entry for every registered source, untruncated', () => {
      // A deadline-cut crawl where every source is a problem: the worst case.
      const problems: ProblemSource[] = catalogue.map((site, i) => ({
        site,
        reason: i % 3 === 0 ? 'blocked' : 'skipped',
      }));
      const record = buildSearchCompleteness('deadline', problems.length, [], problems);

      expect(record.problemSources).toHaveLength(catalogue.length);
      expect(record.problemSourcesTotal).toBe(catalogue.length);
      // Not truncated ⇔ total equals the list's length: a consumer may expire.
      expect(record.problemSourcesTotal).toBe(record.problemSources.length);
      expect(record.problemSources.map((p) => p.site)).toEqual(catalogue);
      expect(isSearchCompleteness(record)).toBe(true);
    });

    it('the cached record of a catalogue-wide crawl reads back', () => {
      const atCap = {
        complete: false,
        stopReason: 'deadline',
        sourcesSkipped: MAX_PROBLEM_SOURCES,
        sourcesFailed: 0,
        sourcesPartial: 0,
        problemSources: Array.from({ length: MAX_PROBLEM_SOURCES }, (_, i) => ({ site: `s${i}`, reason: 'skipped' })),
        problemSourcesTotal: MAX_PROBLEM_SOURCES,
      };
      expect(isSearchCompleteness(atCap)).toBe(true);
    });

    it('a record written under the former 200-entry cap still reads back', () => {
      const legacy = {
        complete: true,
        stopReason: null,
        sourcesSkipped: 0,
        sourcesFailed: 650,
        sourcesPartial: 0,
        problemSources: Array.from({ length: 200 }, (_, i) => ({ site: `s${i}`, reason: 'blocked' })),
        problemSourcesTotal: 650,
      };
      expect(isSearchCompleteness(legacy)).toBe(true);
    });
  });

  describe('isSearchCompleteness (cache read-back guard)', () => {
    it.each([
      ['complete', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 3, ...clean }],
      ['deadline', { complete: false, stopReason: 'deadline', sourcesSkipped: 12, sourcesFailed: 0, ...clean }],
      ['job ceiling', { complete: false, stopReason: 'job_ceiling', sourcesSkipped: 1, sourcesFailed: 1, ...clean }],
      [
        'problem sources',
        {
          complete: true,
          stopReason: null,
          sourcesSkipped: 0,
          sourcesFailed: 1,
          sourcesPartial: 1,
          problemSources: [
            { site: 'a', reason: 'blocked' },
            { site: 'b', reason: 'partial' },
          ],
          problemSourcesTotal: 3,
        },
      ],
      ['extra fields from a newer version', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, ...clean, x: 1 }],
    ])('accepts %s', (_label, value) => {
      expect(isSearchCompleteness(value)).toBe(true);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a legacy raw job array (the other cache entry)', [{ id: 'job-1' }]],
      ['a string', 'complete'],
      ['a pre-FR-20 record (no per-source fields)', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0 }],
      ['complete without stopReason null', { complete: true, stopReason: 'deadline', sourcesSkipped: 0, sourcesFailed: 0, ...clean }],
      ['incomplete with a null stopReason', { complete: false, stopReason: null, sourcesSkipped: 1, sourcesFailed: 0, ...clean }],
      ['an unknown stopReason', { complete: false, stopReason: 'cancelled', sourcesSkipped: 1, sourcesFailed: 0, ...clean }],
      ['a negative count', { complete: true, stopReason: null, sourcesSkipped: -1, sourcesFailed: 0, ...clean }],
      ['a fractional count', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0.5, ...clean }],
      ['a string count', { complete: true, stopReason: null, sourcesSkipped: '0', sourcesFailed: 0, ...clean }],
      ['a missing count', { complete: true, stopReason: null, sourcesSkipped: 0, ...clean }],
      ['complete as a string', { complete: 'true', stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, ...clean }],
      ['problemSources not an array', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, ...clean, problemSources: {} }],
      [
        'a malformed problem source',
        { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, ...clean, problemSources: [{ site: 1 }], problemSourcesTotal: 1 },
      ],
      [
        'more problem sources than the total',
        { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, ...clean, problemSources: [{ site: 'a', reason: 'blocked' }] },
      ],
      [
        'more problem sources than the cap',
        {
          complete: true,
          stopReason: null,
          sourcesSkipped: 0,
          sourcesFailed: 0,
          ...clean,
          problemSources: Array.from({ length: MAX_PROBLEM_SOURCES + 1 }, () => ({ site: 'a', reason: 'blocked' })),
          problemSourcesTotal: MAX_PROBLEM_SOURCES + 1,
        },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isSearchCompleteness(value)).toBe(false);
    });
  });

  it('COMPLETE_SEARCH is frozen (callers spread it, never mutate the shared value)', () => {
    expect(Object.isFrozen(COMPLETE_SEARCH)).toBe(true);
    expect(Object.isFrozen(COMPLETE_SEARCH.problemSources)).toBe(true);
    expect(isSearchCompleteness(COMPLETE_SEARCH)).toBe(true);
  });
});
