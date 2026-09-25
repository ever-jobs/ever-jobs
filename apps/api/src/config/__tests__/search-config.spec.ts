import {
  DEFAULT_CACHE_MAX_JOBS,
  DEFAULT_FANOUT_DEADLINE_MS,
  DEFAULT_LIVENESS_MAX_URLS,
  DEFAULT_MAX_JOBS_PER_SEARCH,
  DEFAULT_MAX_RESULTS_WANTED,
  isCacheableJobCount,
  resolveCacheMaxJobs,
  resolveFanoutDeadlineMs,
  resolveLivenessConfig,
  resolveResultCaps,
} from '../search-config';
import configuration from '../configuration';

/**
 * Spec 1721 (C4) — fan-out deadline env; Spec 1723 (C5) — liveness gate/cap.
 */
describe('resolveFanoutDeadlineMs (Spec 1721)', () => {
  it('defaults to 120 000 ms (unchanged)', () => {
    expect(DEFAULT_FANOUT_DEADLINE_MS).toBe(120_000);
    expect(resolveFanoutDeadlineMs({})).toBe(120_000);
  });

  it('reads EVER_JOBS_FANOUT_DEADLINE_MS', () => {
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: '300000' })).toBe(300_000);
  });

  it('still honours the legacy EVER_JOBS_SEARCH_DEADLINE_MS', () => {
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_SEARCH_DEADLINE_MS: '45000' })).toBe(45_000);
  });

  it('the contract name wins when both are set', () => {
    expect(
      resolveFanoutDeadlineMs({
        EVER_JOBS_FANOUT_DEADLINE_MS: '600000',
        EVER_JOBS_SEARCH_DEADLINE_MS: '45000',
      }),
    ).toBe(600_000);
  });

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['junk', 'ten minutes'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('a %s value falls through to the next source instead of disabling the deadline', (_l, value) => {
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: value })).toBe(120_000);
    expect(
      resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: value, EVER_JOBS_SEARCH_DEADLINE_MS: '9000' }),
    ).toBe(9_000);
  });

  it('passes 0 / negative through (JobsService treats them as "no deadline")', () => {
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: '0' })).toBe(0);
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: '-1' })).toBe(-1);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveFanoutDeadlineMs({ EVER_JOBS_FANOUT_DEADLINE_MS: ' 150000 ' })).toBe(150_000);
  });
});

describe('resolveLivenessConfig (Spec 1723)', () => {
  it('defaults: gate on (honour the request flag), cap 100', () => {
    expect(DEFAULT_LIVENESS_MAX_URLS).toBe(100);
    expect(resolveLivenessConfig({})).toEqual({ enabled: true, maxUrls: 100 });
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' Off '])('EVER_JOBS_LIVENESS_ENABLED=%j disables', (v) => {
    expect(resolveLivenessConfig({ EVER_JOBS_LIVENESS_ENABLED: v }).enabled).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', '', 'maybe'])('EVER_JOBS_LIVENESS_ENABLED=%j keeps the gate open', (v) => {
    expect(resolveLivenessConfig({ EVER_JOBS_LIVENESS_ENABLED: v }).enabled).toBe(true);
  });

  it.each([
    ['25', 25],
    ['2.9', 2],
    ['0', 0],
    ['-5', 0],
    ['', 100],
    ['lots', 100],
  ])('EVER_JOBS_LIVENESS_MAX_URLS=%j → %d', (v, expected) => {
    expect(resolveLivenessConfig({ EVER_JOBS_LIVENESS_MAX_URLS: v }).maxUrls).toBe(expected);
  });
});

describe('configuration() wiring', () => {
  const keys = [
    'EVER_JOBS_FANOUT_DEADLINE_MS',
    'EVER_JOBS_SEARCH_DEADLINE_MS',
    'EVER_JOBS_LIVENESS_ENABLED',
    'EVER_JOBS_LIVENESS_MAX_URLS',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('exposes search.deadlineMs and liveness from the env', () => {
    process.env.EVER_JOBS_FANOUT_DEADLINE_MS = '200000';
    process.env.EVER_JOBS_LIVENESS_ENABLED = 'false';
    process.env.EVER_JOBS_LIVENESS_MAX_URLS = '7';
    const config = configuration();
    expect(config.search.deadlineMs).toBe(200_000);
    expect(config.liveness).toEqual({ enabled: false, maxUrls: 7 });
  });

  it('defaults when nothing is set', () => {
    const config = configuration();
    expect(config.search.deadlineMs).toBe(120_000);
    expect(config.liveness).toEqual({ enabled: true, maxUrls: 100 });
  });
});

describe('resolveResultCaps (Spec 1720 / FR-12)', () => {
  it('defaults: 1000 per source, 40000 per search (FR-13 lowered it from 100000)', () => {
    expect(DEFAULT_MAX_RESULTS_WANTED).toBe(1_000);
    expect(DEFAULT_MAX_JOBS_PER_SEARCH).toBe(40_000);
    expect(resolveResultCaps({})).toEqual({ maxResultsWanted: 1_000, maxJobsPerSearch: 40_000 });
  });

  it('reads both variables and floors them', () => {
    expect(
      resolveResultCaps({ EVER_JOBS_MAX_RESULTS_WANTED: '250.9', EVER_JOBS_MAX_JOBS_PER_SEARCH: ' 40000 ' }),
    ).toEqual({ maxResultsWanted: 250, maxJobsPerSearch: 40_000 });
  });

  it('0 or negative disables a cap; blank or junk keeps the default', () => {
    expect(
      resolveResultCaps({ EVER_JOBS_MAX_RESULTS_WANTED: '0', EVER_JOBS_MAX_JOBS_PER_SEARCH: '-1' }),
    ).toEqual({ maxResultsWanted: 0, maxJobsPerSearch: 0 });
    expect(
      resolveResultCaps({ EVER_JOBS_MAX_RESULTS_WANTED: '', EVER_JOBS_MAX_JOBS_PER_SEARCH: 'lots' }),
    ).toEqual({ maxResultsWanted: 1_000, maxJobsPerSearch: 40_000 });
  });

  it('configuration() exposes them under search.*', () => {
    const saved = process.env.EVER_JOBS_MAX_JOBS_PER_SEARCH;
    try {
      process.env.EVER_JOBS_MAX_JOBS_PER_SEARCH = '5000';
      expect(configuration().search).toMatchObject({ maxResultsWanted: 1_000, maxJobsPerSearch: 5_000 });
    } finally {
      if (saved === undefined) delete process.env.EVER_JOBS_MAX_JOBS_PER_SEARCH;
      else process.env.EVER_JOBS_MAX_JOBS_PER_SEARCH = saved;
    }
  });
});

describe('resolveCacheMaxJobs / isCacheableJobCount (Spec 1720 / FR-13)', () => {
  it('defaults to 5000', () => {
    expect(DEFAULT_CACHE_MAX_JOBS).toBe(5_000);
    expect(resolveCacheMaxJobs({})).toBe(5_000);
    expect(resolveCacheMaxJobs({ EVER_JOBS_CACHE_MAX_JOBS: '  ' })).toBe(5_000);
    expect(resolveCacheMaxJobs({ EVER_JOBS_CACHE_MAX_JOBS: 'many' })).toBe(5_000);
  });

  it('reads and floors a value; 0 or negative means never cache', () => {
    expect(resolveCacheMaxJobs({ EVER_JOBS_CACHE_MAX_JOBS: '1200.7' })).toBe(1_200);
    expect(resolveCacheMaxJobs({ EVER_JOBS_CACHE_MAX_JOBS: '0' })).toBe(0);
    expect(resolveCacheMaxJobs({ EVER_JOBS_CACHE_MAX_JOBS: '-5' })).toBe(0);
  });

  it('caches up to and including the limit, never with 0', () => {
    expect(isCacheableJobCount(5_000, 5_000)).toBe(true);
    expect(isCacheableJobCount(5_001, 5_000)).toBe(false);
    expect(isCacheableJobCount(0, 0)).toBe(false);
    expect(isCacheableJobCount(1, 0)).toBe(false);
  });

  it('configuration() exposes it as cache.maxJobs', () => {
    const saved = process.env.EVER_JOBS_CACHE_MAX_JOBS;
    try {
      delete process.env.EVER_JOBS_CACHE_MAX_JOBS;
      expect(configuration().cache.maxJobs).toBe(5_000);
      process.env.EVER_JOBS_CACHE_MAX_JOBS = '0';
      expect(configuration().cache.maxJobs).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.EVER_JOBS_CACHE_MAX_JOBS;
      else process.env.EVER_JOBS_CACHE_MAX_JOBS = saved;
    }
  });
});
