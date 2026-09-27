import { DEFAULT_CIRCUIT_POLICY, ERR_SOURCE_CIRCUIT_OPEN, Site } from '@ever-jobs/models';
import { CRAWL_ENV, resetCrawlPolicyEnvCache } from '@ever-jobs/common';
import {
  BREAKER_COUNT_REFUSALS_ENV,
  BREAKER_REFUSAL_REASONS,
  CircuitBreakerService,
  ERR_SOURCE_REFUSED,
  readBreakerCountRefusals,
  refusedEmptyResult,
} from '../circuit-breaker.service';

/**
 * Spec 1714 FR-15 (audit K2) — a plugin that turns its failures into a resolved,
 * empty response with a `rate_limited` / `blocked` diagnostic (Softy does) must
 * still be able to trip its breaker. `EVER_JOBS_BREAKER_COUNT_REFUSALS=false`
 * restores the pre-1714 behaviour (every resolved call is a success).
 *
 * Red control of the key test: set {@link KEY_TEST_ENV} to `'false'` → the
 * breaker stays `closed` and the 6th call reaches the plugin (test goes red).
 */
const KEY_TEST_ENV: string | undefined = undefined;

const SITE = 'softy' as Site;

/** The shape `JobResponseDto` has, without importing the plugin contract. */
function response(jobs: unknown[], reason?: string, detail?: string): { jobs: unknown[]; diagnostics?: { reason: string; detail?: string } } {
  return reason === undefined ? { jobs } : { jobs, diagnostics: { reason, ...(detail !== undefined ? { detail } : {}) } };
}

describe('CircuitBreakerService — refused empty results (Spec 1714 FR-15)', () => {
  const saved = process.env[BREAKER_COUNT_REFUSALS_ENV];
  let now: number;

  function breaker(envValue: string | undefined = KEY_TEST_ENV): CircuitBreakerService {
    if (envValue === undefined) delete process.env[BREAKER_COUNT_REFUSALS_ENV];
    else process.env[BREAKER_COUNT_REFUSALS_ENV] = envValue;
    const service = new CircuitBreakerService();
    now = 1_000_000;
    service.setClock(() => now);
    return service;
  }

  afterEach(() => {
    if (saved === undefined) delete process.env[BREAKER_COUNT_REFUSALS_ENV];
    else process.env[BREAKER_COUNT_REFUSALS_ENV] = saved;
  });

  describe('readBreakerCountRefusals', () => {
    it('defaults to true when unset or empty', () => {
      expect(readBreakerCountRefusals({})).toBe(true);
      expect(readBreakerCountRefusals({ [BREAKER_COUNT_REFUSALS_ENV]: ' ' })).toBe(true);
    });

    it.each([
      ['false', false],
      ['0', false],
      ['NO', false],
      ['off', false],
      ['true', true],
      ['1', true],
      ['Yes', true],
      ['on', true],
    ])('reads %p as %p', (raw, expected) => {
      expect(readBreakerCountRefusals({ [BREAKER_COUNT_REFUSALS_ENV]: raw })).toBe(expected);
    });

    it('warns on an invalid value and keeps the default', () => {
      const onInvalid = jest.fn();
      expect(readBreakerCountRefusals({ [BREAKER_COUNT_REFUSALS_ENV]: 'maybe' }, onInvalid)).toBe(true);
      expect(onInvalid).toHaveBeenCalledWith('maybe', true);
    });

    // Spec 1715 review F7: the `legacy` crawl preset restores the pre-1714 default.
    it('defaults to false under EVER_JOBS_CRAWL_PRESET=legacy (any spelling the crawl layer accepts)', () => {
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'legacy' })).toBe(false);
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: ' LEGACY ' })).toBe(false);
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'polite' })).toBe(true);
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'strict' })).toBe(true);
      // An invalid preset is `polite` for the crawl layer, so it is not legacy here either.
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'legacyish' })).toBe(true);
    });

    it('an explicit value wins over the legacy preset', () => {
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'legacy', [BREAKER_COUNT_REFUSALS_ENV]: 'true' })).toBe(true);
      expect(readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'legacy', [BREAKER_COUNT_REFUSALS_ENV]: 'off' })).toBe(false);
    });

    it('an invalid value under the legacy preset keeps the legacy default and says so', () => {
      const onInvalid = jest.fn();
      expect(
        readBreakerCountRefusals({ [CRAWL_ENV.PRESET]: 'legacy', [BREAKER_COUNT_REFUSALS_ENV]: 'maybe' }, onInvalid),
      ).toBe(false);
      expect(onInvalid).toHaveBeenCalledWith('maybe', false);
    });

    it('is mirrored on the class (the package index exports only the class)', () => {
      expect(CircuitBreakerService.COUNT_REFUSALS_ENV_VAR).toBe('EVER_JOBS_BREAKER_COUNT_REFUSALS');
      expect(CircuitBreakerService.readCountRefusals).toBe(readBreakerCountRefusals);
      expect(CircuitBreakerService.refusedEmptyResult).toBe(refusedEmptyResult);
    });
  });

  describe('refusedEmptyResult', () => {
    it('matches only jobs [] with a rate_limited or blocked diagnostic', () => {
      expect(BREAKER_REFUSAL_REASONS).toEqual(['rate_limited', 'blocked']);
      expect(refusedEmptyResult(response([], 'rate_limited', '429'))).toEqual({ reason: 'rate_limited', detail: '429' });
      expect(refusedEmptyResult(response([], 'blocked'))).toEqual({ reason: 'blocked' });
      expect(refusedEmptyResult(response([{}], 'rate_limited'))).toBeUndefined();
      expect(refusedEmptyResult(response([], 'fetch_error', 'HTTP 503'))).toBeUndefined();
      expect(refusedEmptyResult(response([], 'empty'))).toBeUndefined();
      expect(refusedEmptyResult(response([]))).toBeUndefined();
      expect(refusedEmptyResult({ diagnostics: { reason: 'blocked' } })).toBeUndefined();
      expect(refusedEmptyResult('ok')).toBeUndefined();
      expect(refusedEmptyResult(undefined)).toBeUndefined();
    });
  });

  it('5 refused rate_limited results open the breaker; the 6th call is short-circuited (key test)', async () => {
    const service = breaker();
    const refused = response([], 'rate_limited', 'HTTP 429 from acme.softy.pro');
    const fn = jest.fn(async () => refused);

    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      // The scrape's own result is returned unchanged.
      await expect(service.exec(SITE, fn)).resolves.toBe(refused);
    }
    expect(service.state(SITE)).toBe('open');
    await expect(service.exec(SITE, fn)).rejects.toMatchObject({ code: ERR_SOURCE_CIRCUIT_OPEN });
    expect(fn).toHaveBeenCalledTimes(DEFAULT_CIRCUIT_POLICY.failureThreshold);

    const health = service.health(SITE);
    expect(health.successRate).toBe(0);
    expect(health.lastError).toMatchObject({
      code: ERR_SOURCE_REFUSED,
      message: `${SITE}: resolved with 0 jobs and diagnostic rate_limited: HTTP 429 from acme.softy.pro`,
    });
  });

  it('blocked results count the same way', async () => {
    const service = breaker();
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await service.exec(SITE, async () => response([], 'blocked'));
    }
    expect(service.state(SITE)).toBe('open');
    expect(service.health(SITE).lastError?.message).toBe(`${SITE}: resolved with 0 jobs and diagnostic blocked`);
  });

  it.each([
    ['fetch_error with 0 jobs', response([], 'fetch_error', 'HTTP 503')],
    ['a partial rate_limited result with 3 jobs', response([{}, {}, {}], 'rate_limited')],
    ['an empty board', response([])],
    ['a blocked result with jobs', response([{}], 'blocked')],
  ])('%s is not a failure', async (_label, value) => {
    const service = breaker();
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold + 2; i++) {
      await expect(service.exec(SITE, async () => value)).resolves.toBe(value);
    }
    expect(service.state(SITE)).toBe('closed');
    expect(service.health(SITE).successRate).toBe(1);
  });

  it('a success in between resets the streak, as for thrown failures', async () => {
    const service = breaker();
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold - 1; i++) {
      await service.exec(SITE, async () => response([], 'rate_limited'));
    }
    await service.exec(SITE, async () => response([{}]));
    await service.exec(SITE, async () => response([], 'rate_limited'));
    expect(service.state(SITE)).toBe('closed');
  });

  it('a half-open probe that resolves refused re-opens the breaker', async () => {
    const service = breaker();
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await service.exec(SITE, async () => response([], 'blocked'));
    }
    now += DEFAULT_CIRCUIT_POLICY.cooldownMs;
    expect(service.state(SITE)).toBe('half-open');

    const probe = response([], 'rate_limited');
    await expect(service.exec(SITE, async () => probe)).resolves.toBe(probe);
    expect(service.state(SITE)).toBe('open');
  });

  it('a half-open probe that resolves with jobs closes it, as before', async () => {
    const service = breaker();
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await service.exec(SITE, async () => response([], 'blocked'));
    }
    now += DEFAULT_CIRCUIT_POLICY.cooldownMs;
    await service.exec(SITE, async () => response([{}]));
    expect(service.state(SITE)).toBe('closed');
  });

  it('EVER_JOBS_BREAKER_COUNT_REFUSALS=false restores the pre-1714 behaviour: the breaker stays closed', async () => {
    const service = breaker('false');
    expect(service.getCountRefusals()).toBe(false);
    const fn = jest.fn(async () => response([], 'rate_limited'));
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold + 1; i++) {
      await service.exec(SITE, fn);
    }
    expect(service.state(SITE)).toBe('closed');
    expect(fn).toHaveBeenCalledTimes(DEFAULT_CIRCUIT_POLICY.failureThreshold + 1);
    expect(service.health(SITE).successRate).toBe(1);
  });

  describe('under EVER_JOBS_CRAWL_PRESET=legacy (Spec 1715 review F7)', () => {
    const savedPreset = process.env[CRAWL_ENV.PRESET];

    afterEach(() => {
      if (savedPreset === undefined) delete process.env[CRAWL_ENV.PRESET];
      else process.env[CRAWL_ENV.PRESET] = savedPreset;
      resetCrawlPolicyEnvCache();
    });

    function legacyBreaker(envValue: string | undefined): CircuitBreakerService {
      process.env[CRAWL_ENV.PRESET] = 'legacy';
      resetCrawlPolicyEnvCache();
      return breaker(envValue);
    }

    it('a breaker built without the switch keeps the pre-1714 behaviour: refused results are successes', async () => {
      const service = legacyBreaker(undefined);
      expect(service.getCountRefusals()).toBe(false);
      const fn = jest.fn(async () => response([], 'rate_limited'));
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold + 1; i++) {
        await service.exec(SITE, fn);
      }
      expect(service.state(SITE)).toBe('closed');
      expect(fn).toHaveBeenCalledTimes(DEFAULT_CIRCUIT_POLICY.failureThreshold + 1);
    });

    it('EVER_JOBS_BREAKER_COUNT_REFUSALS=true still counts them under the legacy preset', async () => {
      const service = legacyBreaker('true');
      expect(service.getCountRefusals()).toBe(true);
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
        await service.exec(SITE, async () => response([], 'blocked'));
      }
      expect(service.state(SITE)).toBe('open');
    });
  });

  it('setCountRefusals switches it at runtime', async () => {
    const service = breaker();
    expect(service.getCountRefusals()).toBe(true);
    service.setCountRefusals(false);
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await service.exec(SITE, async () => response([], 'blocked'));
    }
    expect(service.state(SITE)).toBe('closed');
    service.setCountRefusals(true);
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await service.exec(SITE, async () => response([], 'blocked'));
    }
    expect(service.state(SITE)).toBe('open');
  });
});
