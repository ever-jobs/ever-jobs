import { CRAWL_ENV, CRAWL_EXTRA_ENV, resetCrawlPolicyEnvCache } from '@ever-jobs/common';
import configuration from '../configuration';

/**
 * The boot-time `crawl` config mirror (Spec 1690) shows every process-wide Spec
 * 1714 / 1715 restore switch in force (review round 2): after
 * `EVER_JOBS_CRAWL_PRESET=legacy` or an explicit restore value an operator can see
 * that each one took its pre-1714 value. Read-only: the code reads the env itself.
 */
describe('configuration — crawl switches mirror (Spec 1715 review round 2)', () => {
  const VARS = [
    CRAWL_ENV.PRESET,
    CRAWL_EXTRA_ENV.STRICTER_RULES,
    CRAWL_EXTRA_ENV.PROXY_PIN_SCOPE,
    CRAWL_EXTRA_ENV.ROBOTS_BACKOFF,
    CRAWL_EXTRA_ENV.PACE_REDIRECTS,
    CRAWL_EXTRA_ENV.CALLER_PROXY_ROTATION,
    CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE,
    CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE,
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    resetCrawlPolicyEnvCache();
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetCrawlPolicyEnvCache();
  });

  const switches = () => {
    const { crawl } = configuration();
    return {
      stricterRules: crawl.stricterRules,
      proxyPinScope: crawl.proxyPinScope,
      robotsBackoff: crawl.robotsBackoff,
      paceRedirects: crawl.paceRedirects,
      callerProxyRotation: crawl.callerProxyRotation,
      cooldownBeforeRelease: crawl.cooldownBeforeRelease,
      builtinHostsDisabled: crawl.builtinHostsDisabled,
    };
  };

  it('defaults: the new behaviour of every switch', () => {
    expect(switches()).toEqual({
      stricterRules: '1714',
      proxyPinScope: 'base',
      robotsBackoff: true,
      paceRedirects: true,
      callerProxyRotation: 'base',
      cooldownBeforeRelease: 'locked',
      builtinHostsDisabled: [],
    });
  });

  it('EVER_JOBS_CRAWL_PRESET=legacy: the pre-1714 value of every switch', () => {
    process.env[CRAWL_ENV.PRESET] = 'legacy';
    expect(switches()).toEqual({
      stricterRules: '1690',
      proxyPinScope: 'bucket',
      robotsBackoff: false,
      paceRedirects: false,
      callerProxyRotation: 'ranked',
      cooldownBeforeRelease: 'off',
      builtinHostsDisabled: [],
    });
  });

  it('explicit restore values show up one by one', () => {
    process.env[CRAWL_EXTRA_ENV.PROXY_PIN_SCOPE] = 'bucket';
    process.env[CRAWL_EXTRA_ENV.ROBOTS_BACKOFF] = 'false';
    process.env[CRAWL_EXTRA_ENV.CALLER_PROXY_ROTATION] = 'ranked';
    process.env[CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE] = 'off';
    expect(switches()).toMatchObject({
      proxyPinScope: 'bucket',
      robotsBackoff: false,
      callerProxyRotation: 'ranked',
      cooldownBeforeRelease: 'off',
      stricterRules: '1714',
    });
  });
});
