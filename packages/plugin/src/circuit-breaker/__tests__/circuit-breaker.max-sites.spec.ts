import { DEFAULT_CIRCUIT_POLICY, Site } from '@ever-jobs/models';
import {
  CIRCUIT_MAX_SITES_ENV_VAR,
  CIRCUIT_NEUTRAL_ERROR_KEY,
  CircuitBreakerService,
  DEFAULT_CIRCUIT_MAX_SITES,
  LEGACY_CIRCUIT_MAX_SITES,
  isCircuitNeutralError,
  markCircuitNeutral,
  readCircuitMaxSites,
} from '../circuit-breaker.service';

/**
 * Spec 1690 §4.9 — the tracked-site cap (was a hard-coded 250) is configurable
 * through `EVER_JOBS_CIRCUIT_MAX_SITES` (default 4096, `0` = no cap), and
 * Spec 1690 §4.6 — circuit-neutral errors (a scrape we aborted at the search
 * deadline) are recorded neither as failures nor as successes.
 */
describe('CircuitBreakerService — max tracked sites (Spec 1690 §4.9)', () => {
  const saved = process.env[CIRCUIT_MAX_SITES_ENV_VAR];
  afterEach(() => {
    if (saved === undefined) delete process.env[CIRCUIT_MAX_SITES_ENV_VAR];
    else process.env[CIRCUIT_MAX_SITES_ENV_VAR] = saved;
  });

  /** `n` distinct site keys (the breaker accepts any string key). */
  const sites = (n: number): Site[] => Array.from({ length: n }, (_, i) => `site-${i}` as Site);
  const ok = async () => 'ok';
  const fail = async () => {
    throw new Error('boom');
  };

  describe('readCircuitMaxSites', () => {
    it('defaults to 4096 when unset or empty', () => {
      expect(DEFAULT_CIRCUIT_MAX_SITES).toBe(4096);
      expect(readCircuitMaxSites({})).toBe(4096);
      expect(readCircuitMaxSites({ [CIRCUIT_MAX_SITES_ENV_VAR]: '  ' })).toBe(4096);
    });

    it('reads a non-negative integer, including the legacy 250 and 0 (no cap)', () => {
      expect(readCircuitMaxSites({ [CIRCUIT_MAX_SITES_ENV_VAR]: '250' })).toBe(LEGACY_CIRCUIT_MAX_SITES);
      expect(readCircuitMaxSites({ [CIRCUIT_MAX_SITES_ENV_VAR]: ' 10000 ' })).toBe(10000);
      expect(readCircuitMaxSites({ [CIRCUIT_MAX_SITES_ENV_VAR]: '0' })).toBe(0);
    });

    it.each(['-1', '1.5', 'lots', '1e3', '99999999999999999999'])(
      'ignores %p with a warning and falls back to the default',
      (raw) => {
        const onInvalid = jest.fn();
        expect(readCircuitMaxSites({ [CIRCUIT_MAX_SITES_ENV_VAR]: raw }, onInvalid)).toBe(4096);
        expect(onInvalid).toHaveBeenCalledWith(raw);
      },
    );

    it('is mirrored on the class for consumers of the package index', () => {
      expect(CircuitBreakerService.readMaxSites).toBe(readCircuitMaxSites);
      expect(CircuitBreakerService.MAX_SITES_ENV_VAR).toBe('EVER_JOBS_CIRCUIT_MAX_SITES');
      expect(CircuitBreakerService.DEFAULT_MAX_SITES).toBe(4096);
    });
  });

  it('tracks more than the pre-1690 250 sites by default, so every source can trip', async () => {
    delete process.env[CIRCUIT_MAX_SITES_ENV_VAR];
    const breaker = new CircuitBreakerService();
    expect(breaker.getMaxSites()).toBe(4096);

    const all = sites(300);
    for (const site of all) await breaker.exec(site, ok);
    expect(breaker.list()).toHaveLength(300);

    // The 300th site trips like any other.
    const last = all[299];
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      await expect(breaker.exec(last, fail)).rejects.toThrow('boom');
    }
    expect(breaker.state(last)).toBe('open');
  });

  it('EVER_JOBS_CIRCUIT_MAX_SITES=250 restores the pre-1690 cap (sites past it cannot trip)', async () => {
    process.env[CIRCUIT_MAX_SITES_ENV_VAR] = '250';
    const breaker = new CircuitBreakerService();
    expect(breaker.getMaxSites()).toBe(250);

    const all = sites(251);
    for (const site of all.slice(0, 250)) await breaker.exec(site, ok);
    const extra = all[250];
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold + 1; i++) {
      await expect(breaker.exec(extra, fail)).rejects.toThrow('boom');
    }
    expect(breaker.list()).toHaveLength(250);
    // An untracked site gets a throwaway entry each time — it never opens.
    expect(breaker.state(extra)).toBe('closed');
  });

  it('0 means no cap', async () => {
    process.env[CIRCUIT_MAX_SITES_ENV_VAR] = '0';
    const breaker = new CircuitBreakerService();
    for (const site of sites(20)) await breaker.exec(site, ok);
    expect(breaker.getMaxSites()).toBe(0);
    expect(breaker.list()).toHaveLength(20);
  });

  it('an invalid value falls back to the default without throwing', () => {
    process.env[CIRCUIT_MAX_SITES_ENV_VAR] = 'many';
    expect(new CircuitBreakerService().getMaxSites()).toBe(4096);
  });

  it('setMaxSites changes the cap at runtime and rejects nonsense', async () => {
    const breaker = new CircuitBreakerService();
    breaker.setMaxSites(2);
    for (const site of sites(3)) await breaker.exec(site, ok);
    expect(breaker.list()).toHaveLength(2);
    expect(() => breaker.setMaxSites(-1)).toThrow(RangeError);
    expect(() => breaker.setMaxSites(1.5)).toThrow(RangeError);
  });
});

describe('CircuitBreakerService — circuit-neutral errors (Spec 1690 §4.6)', () => {
  const SITE = Site.LINKEDIN;
  let breaker: CircuitBreakerService;
  let now: number;

  beforeEach(() => {
    breaker = new CircuitBreakerService();
    now = 1_000_000;
    breaker.setClock(() => now);
  });

  const neutral = async () => {
    throw markCircuitNeutral(new Error('aborted at the search deadline'));
  };
  const fail = async () => {
    throw new Error('boom');
  };

  it('markCircuitNeutral tags an error in place, non-enumerably', () => {
    const err = new Error('x');
    expect(markCircuitNeutral(err)).toBe(err);
    expect(isCircuitNeutralError(err)).toBe(true);
    expect(Object.keys(err)).not.toContain(CIRCUIT_NEUTRAL_ERROR_KEY);
    expect(CircuitBreakerService.markNeutral).toBe(markCircuitNeutral);
    expect(CircuitBreakerService.isNeutralError).toBe(isCircuitNeutralError);
  });

  it('markCircuitNeutral wraps primitives and frozen objects', () => {
    const fromString = markCircuitNeutral('nope');
    expect(fromString).toBeInstanceOf(Error);
    expect(isCircuitNeutralError(fromString)).toBe(true);

    const frozen = Object.freeze(new Error('frozen'));
    const wrapped = markCircuitNeutral(frozen) as Error;
    expect(wrapped).not.toBe(frozen);
    expect(wrapped.message).toBe('frozen');
    expect(isCircuitNeutralError(wrapped)).toBe(true);
  });

  it('isCircuitNeutralError is false for ordinary errors and non-objects', () => {
    expect(isCircuitNeutralError(new Error('x'))).toBe(false);
    expect(isCircuitNeutralError(undefined)).toBe(false);
    expect(isCircuitNeutralError('circuitNeutral')).toBe(false);
  });

  it('neutral errors are rethrown but never count toward opening the breaker', async () => {
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold * 2; i++) {
      await expect(breaker.exec(SITE, neutral)).rejects.toThrow('aborted at the search deadline');
    }
    expect(breaker.state(SITE)).toBe('closed');
    const health = breaker.health(SITE);
    expect(health.successRate).toBe(1);
    expect(health.lastError).toBeUndefined();
  });

  it('a neutral error does not reset a run of real failures either', async () => {
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold - 1; i++) {
      await expect(breaker.exec(SITE, fail)).rejects.toThrow('boom');
    }
    await expect(breaker.exec(SITE, neutral)).rejects.toThrow();
    await expect(breaker.exec(SITE, fail)).rejects.toThrow('boom');
    expect(breaker.state(SITE)).toBe('open');
  });

  it('a neutral half-open probe hands its slot back, so the next call can still probe', async () => {
    breaker.forceOpen(SITE);
    now += DEFAULT_CIRCUIT_POLICY.cooldownMs;

    await expect(breaker.exec(SITE, neutral)).rejects.toThrow();
    expect(breaker.state(SITE)).toBe('half-open');

    // The probe slot came back: a real probe runs and closes the breaker.
    await expect(breaker.exec(SITE, async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state(SITE)).toBe('closed');
  });
});
