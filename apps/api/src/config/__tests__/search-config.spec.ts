import {
  DEFAULT_FANOUT_DEADLINE_MS,
  DEFAULT_LIVENESS_MAX_URLS,
  resolveFanoutDeadlineMs,
  resolveLivenessConfig,
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
