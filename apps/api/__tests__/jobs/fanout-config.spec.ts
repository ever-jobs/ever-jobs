import configuration from '../../src/config/configuration';

/**
 * Fan-out bounds are read from the environment (Spec 5026; Q-107 follow-up 2).
 *
 * `configuration.ts` shadows the global `parseInt` with a local
 * `(value, fallback)` helper, so `parseInt(process.env.X, 120_000)` means
 * "X, or 120 000", not "X in radix 120 000". A review of Specs 1735–1737 read
 * the call as the global (which returns `NaN` for any radix above 36) and
 * concluded the fan-out deadline never applies. It does: these cases pin the
 * defaults and prove each variable takes effect, so the deadline order of the
 * tail-registered company plugins is a live concern, not a future one.
 */
describe('configuration — search fan-out bounds and cache sizing', () => {
  const VARS = [
    'EVER_JOBS_SEARCH_CONCURRENCY',
    'EVER_JOBS_SEARCH_DEADLINE_MS',
    // The contract-C4 name some branches read ahead of the legacy one; kept
    // unset so these cases exercise the variables this file documents.
    'EVER_JOBS_FANOUT_DEADLINE_MS',
    'CACHE_EXPIRY',
    'CACHE_MAX_ITEMS',
  ] as const;
  const saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('defaults to 64 concurrent sources and a 120 s deadline (the deadline is on)', () => {
    const { search } = configuration();

    expect(search.concurrency).toBe(64);
    expect(search.deadlineMs).toBe(120_000);
    expect(Number.isNaN(search.deadlineMs)).toBe(false);
  });

  it('honours EVER_JOBS_SEARCH_CONCURRENCY and EVER_JOBS_SEARCH_DEADLINE_MS', () => {
    process.env.EVER_JOBS_SEARCH_CONCURRENCY = '8';
    process.env.EVER_JOBS_SEARCH_DEADLINE_MS = '90000';

    const { search } = configuration();

    expect(search.concurrency).toBe(8);
    expect(search.deadlineMs).toBe(90_000);
  });

  it('keeps 0 as "deadline disabled" and falls back to the default on a non-number', () => {
    process.env.EVER_JOBS_SEARCH_DEADLINE_MS = '0';
    expect(configuration().search.deadlineMs).toBe(0);

    process.env.EVER_JOBS_SEARCH_DEADLINE_MS = 'soon';
    process.env.EVER_JOBS_SEARCH_CONCURRENCY = 'many';
    const { search } = configuration();
    expect(search.deadlineMs).toBe(120_000);
    expect(search.concurrency).toBe(64);
  });

  it('honours CACHE_EXPIRY and CACHE_MAX_ITEMS through the same helper', () => {
    expect(configuration().cache).toMatchObject({ expirySec: 3600, maxItems: 500 });

    process.env.CACHE_EXPIRY = '60';
    process.env.CACHE_MAX_ITEMS = '25';

    expect(configuration().cache).toMatchObject({ expirySec: 60, maxItems: 25 });
  });
});
