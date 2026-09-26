import { MAX_CRAWL_RETRIES } from '@ever-jobs/models';

import {
  BUILTIN_HOST_POLICIES,
  CRAWL_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  LEGACY_BROWSER_USER_AGENT,
  LEGACY_CRAWL_POLICY,
  POLITE_CRAWL_POLICY,
  STRICT_CRAWL_POLICY,
} from '../src/http/crawl/defaults';
import { readCrawlPolicyEnv, resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import {
  CRAWL_CALLER_SECURITY_FIELDS,
  CRAWL_POLICY_FIELDS,
  explainCrawlPolicy,
  filterCallerOverride,
  matchHostPattern,
  normalizeCrawlHostName,
  normalizeCrawlHostPattern,
  normalizeCrawlOverride,
  resolveCrawlPolicy,
} from '../src/http/crawl/resolve';
import { CallerOverridePolicy, CrawlPolicy, CrawlPolicyEnvConfig, CrawlPolicyOverride } from '../src/http/crawl/types';

/** Spec 1690 §4.1 — layer precedence, provenance, caller filtering, host patterns. */
describe('resolveCrawlPolicy (Spec 1690)', () => {
  const envOf = (vars: Record<string, string> = {}) => readCrawlPolicyEnv(vars as NodeJS.ProcessEnv);
  const policiesEnv = (policies: object, vars: Record<string, string> = {}) =>
    envOf({ ...vars, [CRAWL_ENV.POLICIES]: JSON.stringify(policies) });

  /** The policy fields of a resolved policy (drops `provenance`). */
  const fieldsOf = (resolved: CrawlPolicy & { provenance?: unknown }): CrawlPolicy => {
    const { provenance: _provenance, ...rest } = resolved;
    return rest as CrawlPolicy;
  };

  describe('presets', () => {
    it.each([
      ['polite', POLITE_CRAWL_POLICY],
      ['legacy', LEGACY_CRAWL_POLICY],
      ['strict', STRICT_CRAWL_POLICY],
    ] as const)('%s resolves to the preset, every field from "preset"', (preset, expected) => {
      const resolved = resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.PRESET]: preset }));
      expect(fieldsOf(resolved)).toEqual(expected);
      for (const field of Object.keys(expected) as (keyof CrawlPolicy)[]) {
        expect(resolved.provenance[field]).toBe('preset');
      }
      expect(resolved.provenance.from).toBeUndefined();
    });

    it('never mutates the preset objects', () => {
      const resolved = resolveCrawlPolicy({ caller: { retries: 0, retryStatuses: [429] } }, envOf());
      resolved.retryStatuses.push(999);
      expect(POLITE_CRAWL_POLICY.retries).toBe(2);
      expect(POLITE_CRAWL_POLICY.retryStatuses).toEqual([429, 502, 503, 504]);
    });

    it('an unknown preset in a hand-built config falls back to polite with a note', () => {
      const env = { ...envOf(), preset: 'rude' } as unknown as CrawlPolicyEnvConfig;
      const explained = explainCrawlPolicy({}, env);
      expect(explained.preset).toBe('polite');
      expect(explained.notes).toEqual([expect.stringContaining('unknown preset')]);
    });

    it('a minimal hand-built config uses the documented defaults silently; a bad callerOverrides fails safe', () => {
      const minimal = { global: {} } as unknown as CrawlPolicyEnvConfig;
      const explained = explainCrawlPolicy({ caller: { retries: 9 } }, minimal);
      expect(explained).toMatchObject({ preset: 'polite', callerOverrides: 'any', notes: [] });
      expect(explained.policy.retries).toBe(9);

      const bad = { ...envOf(), callerOverrides: 'lenient' } as unknown as CrawlPolicyEnvConfig;
      const strict = explainCrawlPolicy({ caller: { retries: 9 } }, bad);
      expect(strict.callerOverrides).toBe('stricter');
      expect(strict.policy.retries).toBe(POLITE_CRAWL_POLICY.retries);
      expect(strict.notes).toEqual([expect.stringContaining('unknown callerOverrides')]);
    });
  });

  describe('legacy = exactly pre-1690 (no layer that did not exist before)', () => {
    const legacy = () => envOf({ [CRAWL_ENV.PRESET]: 'legacy' });
    const SOFTY_MANIFEST = { rateLimitScope: 'domain' as const, maxConcurrentPerHost: 1, minIntervalMs: 1000 };

    it.each(['api.greenhouse.io', 'boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.smartrecruiters.com'])(
      'no builtin host limit for %s (noted)',
      (host) => {
        const explained = explainCrawlPolicy({ host }, legacy());
        expect(explained.policy.maxConcurrentPerHost).toBe(0);
        expect(explained.policy.minIntervalMs).toBe(0);
        expect(explained.builtinHost).toBeUndefined();
        expect(explained.notes).toEqual([expect.stringContaining('EVER_JOBS_CRAWL_BUILTIN_HOSTS=false')]);
      },
    );

    it('no plugin manifest (Softy stays unpaced); the explicit createHttpClient options still apply', () => {
      const explained = explainCrawlPolicy(
        { site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST, explicit: { retries: 1 } },
        legacy(),
      );
      expect(explained.policy).toMatchObject({ maxConcurrentPerHost: 0, minIntervalMs: 0, rateLimitScope: 'host', retries: 1 });
      expect(explained.notes).toEqual([expect.stringContaining('EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false')]);
    });

    it('both layers can be switched back on under legacy, and off under polite', () => {
      const on = envOf({
        [CRAWL_ENV.PRESET]: 'legacy',
        EVER_JOBS_CRAWL_BUILTIN_HOSTS: 'true',
        EVER_JOBS_CRAWL_PLUGIN_MANIFESTS: 'yes',
      });
      expect(resolveCrawlPolicy({ host: 'api.lever.co' }, on).maxConcurrentPerHost).toBe(12);
      expect(resolveCrawlPolicy({ plugin: SOFTY_MANIFEST }, on).maxConcurrentPerHost).toBe(1);

      const off = envOf({ EVER_JOBS_CRAWL_BUILTIN_HOSTS: 'false', EVER_JOBS_CRAWL_PLUGIN_MANIFESTS: '0' });
      expect(resolveCrawlPolicy({ host: 'api.lever.co' }, off).maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
      expect(resolveCrawlPolicy({ plugin: SOFTY_MANIFEST }, off).minIntervalMs).toBe(POLITE_CRAWL_POLICY.minIntervalMs);
    });

    it('a hand-built config without the switches defaults them by preset', () => {
      const { builtinHosts: _b, pluginManifests: _p, ...bare } = legacy() as CrawlPolicyEnvConfig & Record<string, unknown>;
      expect(resolveCrawlPolicy({ host: 'api.lever.co' }, bare as CrawlPolicyEnvConfig).maxConcurrentPerHost).toBe(0);
      const { builtinHosts: _b2, ...politeBare } = envOf() as CrawlPolicyEnvConfig & Record<string, unknown>;
      expect(resolveCrawlPolicy({ host: 'api.lever.co' }, politeBare as CrawlPolicyEnvConfig).maxConcurrentPerHost).toBe(12);
    });

    it('maxRetryAfterMs follows retryMaxDelayMs (the one pre-1690 ceiling) unless a layer sets it', () => {
      const perSource = envOf({ [CRAWL_ENV.PRESET]: 'legacy', RETRY_PER_SOURCE: '{"softy":{"maxDelayMs":60000}}' });
      const followed = resolveCrawlPolicy({ site: 'softy' }, perSource);
      expect(followed.maxRetryAfterMs).toBe(60_000);
      expect(followed.provenance.maxRetryAfterMs).toBe('operator-site');

      expect(resolveCrawlPolicy({ caller: { retryMaxDelayMs: 5000 } }, legacy()).maxRetryAfterMs).toBe(5000);
      expect(resolveCrawlPolicy({ caller: { retryMaxDelayMs: 5000, maxRetryAfterMs: 90_000 } }, legacy()).maxRetryAfterMs).toBe(90_000);
      expect(resolveCrawlPolicy({}, legacy()).maxRetryAfterMs).toBe(30_000);
      // Not under polite: there the two are separate knobs.
      expect(resolveCrawlPolicy({ caller: { retryMaxDelayMs: 5000 } }, envOf()).maxRetryAfterMs).toBe(POLITE_CRAWL_POLICY.maxRetryAfterMs);
    });
  });

  describe('throttleRetryDelayMs — the 429/503 back-off floor', () => {
    it('presets: polite 5 s, strict 30 s, legacy 0 (off, as before 1690)', () => {
      expect(resolveCrawlPolicy({}, envOf()).throttleRetryDelayMs).toBe(5000);
      expect(resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.PRESET]: 'strict' })).throttleRetryDelayMs).toBe(30_000);
      expect(resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.PRESET]: 'legacy' })).throttleRetryDelayMs).toBe(0);
    });

    it('EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS sets it at the env-global layer', () => {
      const resolved = resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: '12000' }));
      expect(resolved.throttleRetryDelayMs).toBe(12_000);
      expect(resolved.provenance.throttleRetryDelayMs).toBe('env-global');
      expect(resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: '0' })).throttleRetryDelayMs).toBe(0);
    });

    it.each(['-1', 'soon', '5s'])('an invalid env value (%j) is warned about and ignored (the preset stands)', (raw) => {
      const env = envOf({ [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: raw });
      expect(env.warnings).toEqual([expect.stringContaining(CRAWL_ENV.THROTTLE_RETRY_DELAY_MS)]);
      const resolved = resolveCrawlPolicy({}, env);
      expect(resolved.throttleRetryDelayMs).toBe(POLITE_CRAWL_POLICY.throttleRetryDelayMs);
      expect(resolved.provenance.throttleRetryDelayMs).toBe('preset');
    });

    it('operator site / host policies set it per site and per host', () => {
      const env = policiesEnv({ sites: { softy: { throttleRetryDelayMs: 20_000 } }, hosts: { '*.softy.pro': { throttleRetryDelayMs: 60_000 } } });
      expect(resolveCrawlPolicy({ site: 'softy' }, env).throttleRetryDelayMs).toBe(20_000);
      const host = resolveCrawlPolicy({ site: 'softy', host: 'acme.softy.pro' }, env);
      expect(host.throttleRetryDelayMs).toBe(60_000);
      expect(host.provenance.throttleRetryDelayMs).toBe('operator-host');
    });

    it('caller under stricter: a higher floor is accepted, a lower one (or 0) is refused', () => {
      const stricterEnv = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
      const higher = explainCrawlPolicy({ caller: { throttleRetryDelayMs: 10_000 } }, stricterEnv);
      expect(higher.policy.throttleRetryDelayMs).toBe(10_000);
      expect(higher.policy.provenance.throttleRetryDelayMs).toBe('caller');
      expect(higher.callerRejected).toEqual([]);

      for (const lower of [4999, 0]) {
        const refused = explainCrawlPolicy({ caller: { throttleRetryDelayMs: lower } }, stricterEnv);
        expect(refused.policy.throttleRetryDelayMs).toBe(5000);
        expect(refused.callerRejected).toEqual(['throttleRetryDelayMs']);
      }
      // Under `any` (the default) a caller may lower or disable it.
      expect(resolveCrawlPolicy({ caller: { throttleRetryDelayMs: 0 } }, envOf()).throttleRetryDelayMs).toBe(0);
    });
  });

  describe(`retries — at most MAX_CRAWL_RETRIES (${MAX_CRAWL_RETRIES}) at every layer`, () => {
    it('a plugin manifest, plugin options and a caller each get clamped, with a note', () => {
      const explained = explainCrawlPolicy({ plugin: { retries: 50 } }, envOf());
      expect(explained.policy.retries).toBe(MAX_CRAWL_RETRIES);
      expect(explained.policy.provenance.retries).toBe('plugin');
      expect(explained.notes).toEqual([expect.stringMatching(/^plugin manifest: retries: .*clamped to 10/)]);

      const options = explainCrawlPolicy({ explicit: { retries: 2 ** 31 - 1 } }, envOf());
      expect(options.policy.retries).toBe(MAX_CRAWL_RETRIES);
      expect(options.notes).toEqual([expect.stringContaining('clamped to 10')]);

      const caller = explainCrawlPolicy({ caller: { retries: 11 } }, envOf());
      expect(caller.policy.retries).toBe(MAX_CRAWL_RETRIES);
      expect(caller.policy.provenance.retries).toBe('caller');
      expect(caller.notes).toEqual([expect.stringMatching(/^caller: retries: .*clamped to 10/)]);
    });

    it('env and operator layers are bounded too; values within the cap are untouched', () => {
      expect(resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.RETRIES]: '40' })).retries).toBe(MAX_CRAWL_RETRIES);
      expect(resolveCrawlPolicy({ site: 'softy' }, policiesEnv({ sites: { softy: { retries: 99 } } })).retries).toBe(MAX_CRAWL_RETRIES);
      expect(resolveCrawlPolicy({ caller: { retries: MAX_CRAWL_RETRIES } }, envOf()).retries).toBe(MAX_CRAWL_RETRIES);
      expect(normalizeCrawlOverride({ retries: 7 })).toEqual({ value: { retries: 7 }, warnings: [] });
    });
  });

  describe('layer validation is memoised per layer object', () => {
    it('resolves identically on repeat, and re-reports the same notes each time', () => {
      const env = policiesEnv({ sites: { softy: { maxConcurrentPerHost: 'lots' } } });
      const plugin = { minIntervalMs: 250, bogus: 1 } as unknown as CrawlPolicyOverride;
      const first = explainCrawlPolicy({ site: 'softy', plugin }, env);
      const second = explainCrawlPolicy({ site: 'softy', plugin }, env);
      expect(second.policy).toEqual(first.policy);
      expect(second.notes).toEqual(first.notes);
      expect(first.notes).toHaveLength(1); // the bad site value was dropped at env-parse time; `bogus` noted here
      expect(first.policy.minIntervalMs).toBe(250);
    });
  });

  describe('layer precedence', () => {
    it('env-global overrides the preset', () => {
      const resolved = resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.MIN_INTERVAL_MS]: '750', [CRAWL_ENV.FROM]: 'ops@x' }));
      expect(resolved.minIntervalMs).toBe(750);
      expect(resolved.provenance.minIntervalMs).toBe('env-global');
      expect(resolved.from).toBe('ops@x');
      expect(resolved.provenance.from).toBe('env-global');
      expect(resolved.provenance.retries).toBe('preset');
    });

    it('builtin-host applies to the exact host only and beats env-global', () => {
      const env = envOf({ [CRAWL_ENV.MAX_CONCURRENT_PER_HOST]: '2', [CRAWL_ENV.MIN_INTERVAL_MS]: '300' });
      const gh = resolveCrawlPolicy({ host: 'boards-api.greenhouse.io' }, env);
      expect(gh.maxConcurrentPerHost).toBe(16);
      expect(gh.minIntervalMs).toBe(0);
      expect(gh.provenance.maxConcurrentPerHost).toBe('builtin-host');

      const other = resolveCrawlPolicy({ host: 'x.boards-api.greenhouse.io' }, env);
      expect(other.maxConcurrentPerHost).toBe(2);
      expect(other.provenance.maxConcurrentPerHost).toBe('env-global');
    });

    it.each(['API.Lever.co', 'api.lever.co.', 'api.lever.co:443', 'https://api.lever.co/v0/postings/acme'])(
      'normalises the host %j before the builtin lookup',
      (host) => {
        const explained = explainCrawlPolicy({ host }, envOf());
        expect(explained.builtinHost).toBe('api.lever.co');
        expect(explained.policy.maxConcurrentPerHost).toBe(BUILTIN_HOST_POLICIES['api.lever.co'].maxConcurrentPerHost);
      },
    );

    it('plugin manifest beats builtin-host; explicit createHttpClient options beat the manifest', () => {
      const resolved = resolveCrawlPolicy(
        {
          host: 'api.greenhouse.io',
          plugin: { maxConcurrentPerHost: 3, minIntervalMs: 400, retries: 1 },
          explicit: { retries: 5, minIntervalMs: undefined },
        },
        envOf(),
      );
      expect(resolved.maxConcurrentPerHost).toBe(3);
      expect(resolved.minIntervalMs).toBe(400); // undefined explicit field does not override
      expect(resolved.retries).toBe(5);
      expect(resolved.provenance).toMatchObject({ maxConcurrentPerHost: 'plugin', minIntervalMs: 'plugin', retries: 'plugin' });
    });

    it('operator-site beats plugin; operator-host beats operator-site; caller beats everything', () => {
      const env = policiesEnv({
        sites: { softy: { maxConcurrentPerHost: 2, minIntervalMs: 1500, jitterMs: 10 } },
        hosts: { '*.softy.pro': { minIntervalMs: 2000 } },
      });
      const resolved = resolveCrawlPolicy(
        {
          site: 'softy',
          host: 'acme.softy.pro',
          plugin: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 },
          caller: { jitterMs: 99 },
        },
        env,
      );
      expect(resolved).toMatchObject({ rateLimitScope: 'domain', maxConcurrentPerHost: 2, minIntervalMs: 2000, jitterMs: 99 });
      expect(resolved.provenance).toMatchObject({
        rateLimitScope: 'plugin',
        maxConcurrentPerHost: 'operator-site',
        minIntervalMs: 'operator-host',
        jitterMs: 'caller',
      });
    });

    it('matches the operator site case-insensitively (hand-built configs too)', () => {
      const env = { ...envOf(), policies: { sites: { SoftY: { retries: 0 } }, hosts: {} } };
      const explained = explainCrawlPolicy({ site: 'softy' }, env);
      expect(explained.operatorSite).toBe('SoftY');
      expect(explained.policy.retries).toBe(0);
    });

    it('RETRY_PER_SOURCE lands in the operator-site layer, RETRY_DEFAULT_* in env-global', () => {
      const env = envOf({ RETRY_PER_SOURCE: '{"softy":{"retries":0,"delayMs":5000}}', RETRY_DEFAULT_RETRIES: '4' });
      const softy = resolveCrawlPolicy({ site: 'softy' }, env);
      expect(softy.retries).toBe(0);
      expect(softy.retryBaseDelayMs).toBe(5000);
      expect(softy.provenance.retries).toBe('operator-site');
      const other = resolveCrawlPolicy({ site: 'lever' }, env);
      expect(other.retries).toBe(4);
      expect(other.provenance.retries).toBe('env-global');
    });
  });

  describe('operator host patterns', () => {
    const env = policiesEnv({
      hosts: {
        '*': { minIntervalMs: 1, jitterMs: 1, retries: 1, maxQueueWaitMs: 1 },
        '*.pro': { minIntervalMs: 2, jitterMs: 2, retries: 2 },
        '*.softy.pro': { minIntervalMs: 3, jitterMs: 3 },
        'acme.softy.pro': { minIntervalMs: 4 },
      },
    });

    it('applies every match, least specific first: exact > longest suffix > shorter suffix > *', () => {
      const explained = explainCrawlPolicy({ host: 'acme.softy.pro' }, env);
      expect(explained.operatorHostPatterns).toEqual(['*', '*.pro', '*.softy.pro', 'acme.softy.pro']);
      expect(explained.policy).toMatchObject({ minIntervalMs: 4, jitterMs: 3, retries: 2, maxQueueWaitMs: 1 });
      expect(explained.policy.provenance.minIntervalMs).toBe('operator-host');
    });

    it('a wildcard does not match the apex', () => {
      const explained = explainCrawlPolicy({ host: 'softy.pro' }, env);
      expect(explained.operatorHostPatterns).toEqual(['*', '*.pro']);
      expect(explained.policy.minIntervalMs).toBe(2);
    });

    it('"*" applies above builtin-host and plugin (an operator-wide ceiling)', () => {
      const ceiling = policiesEnv({ hosts: { '*': { maxConcurrentPerHost: 1 } } });
      const resolved = resolveCrawlPolicy({ host: 'api.greenhouse.io', plugin: { maxConcurrentPerHost: 8 } }, ceiling);
      expect(resolved.maxConcurrentPerHost).toBe(1);
      expect(resolved.provenance.maxConcurrentPerHost).toBe('operator-host');
    });

    it('no host → no host layers', () => {
      const explained = explainCrawlPolicy({}, env);
      expect(explained.operatorHostPatterns).toEqual([]);
      expect(explained.builtinHost).toBeUndefined();
      expect(explained.policy.minIntervalMs).toBe(POLITE_CRAWL_POLICY.minIntervalMs);
    });
  });

  describe('User-Agent', () => {
    it('expands UA keywords at every layer, with the operator contact', () => {
      const env = policiesEnv({ sites: { softy: { userAgent: 'default' } } }, { [CRAWL_ENV.CONTACT]: 'ops@x' });
      expect(resolveCrawlPolicy({ site: 'softy' }, env).userAgent).toBe(`${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@x)`);
      expect(resolveCrawlPolicy({ caller: { userAgent: 'browser' } }, env).userAgent).toBe(LEGACY_BROWSER_USER_AGENT);
      expect(resolveCrawlPolicy({}, env).userAgent).toBe(`${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@x)`);
    });

    it('a plugin may opt into userAgentMode "plugin" under identify; the reason is carried, not in the policy', () => {
      const explained = explainCrawlPolicy(
        { site: 'usajobs', plugin: { userAgentMode: 'plugin', userAgentReason: 'API requires the registered e-mail' } },
        envOf(),
      );
      expect(explained.policy.userAgentMode).toBe('plugin');
      expect(explained.policy.provenance.userAgentMode).toBe('plugin');
      expect(explained.userAgentReason).toBe('API requires the registered e-mail');
      expect(Object.keys(explained.policy)).not.toContain('userAgentReason');
      expect(explained.notes).toEqual([]);
    });

    it('notes a plugin opt-in without a reason (still honoured)', () => {
      const explained = explainCrawlPolicy({ plugin: { userAgentMode: 'plugin' } }, envOf());
      expect(explained.policy.userAgentMode).toBe('plugin');
      expect(explained.userAgentReason).toBeUndefined();
      expect(explained.notes).toEqual([expect.stringContaining('without a userAgentReason')]);
    });

    it.each([
      ['strict preset', { [CRAWL_ENV.PRESET]: 'strict' }, 'preset'],
      ['strict env mode', { [CRAWL_ENV.USER_AGENT_MODE]: 'strict' }, 'env-global'],
      ['legacy preset', { [CRAWL_ENV.PRESET]: 'legacy' }, 'preset'],
    ])('a plugin cannot relax a %s (no exceptions)', (_label, vars, layer) => {
      const explained = explainCrawlPolicy(
        { plugin: { userAgentMode: 'plugin', userAgentReason: 'x' }, explicit: { userAgentMode: 'identify' } },
        envOf(vars),
      );
      expect(explained.policy.userAgentMode).toBe('strict');
      expect(explained.policy.provenance.userAgentMode).toBe(layer);
      expect(explained.userAgentReason).toBeUndefined();
      expect(explained.notes).toEqual(expect.arrayContaining([expect.stringContaining('pins "strict"')]));
    });

    it('a plugin-layer userAgent (manifest or options) is a DECLARED UA: never the configured one, noted', () => {
      const explained = explainCrawlPolicy(
        { plugin: { userAgent: 'Manifest/1' }, explicit: { userAgent: 'Mozilla/5.0 (compatible; StapplyMap/1.0)' } },
        envOf(),
      );
      expect(explained.policy.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(explained.policy.provenance.userAgent).toBe('preset');
      expect(explained.notes).toEqual([expect.stringContaining('plugin declares userAgent')]);
    });

    it('strict + an env UA: a plugin UA cannot replace it (the same relaxation as a mode change)', () => {
      const env = envOf({ [CRAWL_ENV.USER_AGENT_MODE]: 'strict', [CRAWL_ENV.USER_AGENT]: 'OpsBot/1.0 (ops@x.example)' });
      const resolved = resolveCrawlPolicy({ explicit: { userAgent: 'Mozilla/5.0 (compatible; StapplyMap/1.0)' } }, env);
      expect(resolved.userAgent).toBe('OpsBot/1.0 (ops@x.example)');
      expect(resolved.userAgentMode).toBe('strict');
      expect(resolved.provenance.userAgent).toBe('env-global');
    });

    it('the reason may come with the explicit options too (createHttpClient({ crawl: POLICY }))', () => {
      const explained = explainCrawlPolicy(
        { explicit: { userAgentMode: 'plugin', userAgentReason: 'API needs its app UA' } as never },
        envOf(),
      );
      expect(explained.userAgentReason).toBe('API needs its app UA');
    });

    it('operator and caller layers may still set the mode above a plugin', () => {
      const env = policiesEnv({ sites: { usajobs: { userAgentMode: 'strict' } } });
      const explained = explainCrawlPolicy(
        { site: 'usajobs', plugin: { userAgentMode: 'plugin', userAgentReason: 'x' } },
        env,
      );
      expect(explained.policy.userAgentMode).toBe('strict');
      expect(explained.userAgentReason).toBeUndefined();
    });

    it('a caller userAgent without a mode implies strict (their UA is what goes out)', () => {
      const resolved = resolveCrawlPolicy({ caller: { userAgent: 'CallerBot/1.0' } }, envOf());
      expect(resolved.userAgent).toBe('CallerBot/1.0');
      expect(resolved.userAgentMode).toBe('strict');
      expect(resolved.provenance).toMatchObject({ userAgent: 'caller', userAgentMode: 'caller' });
    });

    it('a caller userAgent with an explicit mode keeps that mode', () => {
      const resolved = resolveCrawlPolicy({ caller: { userAgent: 'CallerBot/1.0', userAgentMode: 'plugin' } }, envOf());
      expect(resolved.userAgentMode).toBe('plugin');
    });

    it('no implied strict when the caller UA is rejected', () => {
      const env = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
      const explained = explainCrawlPolicy({ caller: { userAgent: 'CallerBot/1.0' } }, env);
      expect(explained.policy.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(explained.policy.userAgentMode).toBe('identify');
      expect(explained.callerRejected).toEqual(['userAgent']);
    });
  });

  describe('caller layer', () => {
    const everything: CrawlPolicyOverride = {
      userAgent: 'CallerBot/1.0',
      userAgentMode: 'plugin',
      proxyRotation: 'per-request',
      maxConcurrentPerHost: 0,
      minIntervalMs: 0,
      retries: 9,
      discovery: 'sitemap',
    };

    it('any (default): accepted as sent', () => {
      const explained = explainCrawlPolicy({ caller: everything }, envOf());
      expect(explained.callerOverrides).toBe('any');
      expect(explained.policy).toMatchObject(everything);
      expect(explained.callerRejected).toEqual([]);
      for (const field of Object.keys(everything) as (keyof CrawlPolicy)[]) {
        expect(explained.policy.provenance[field]).toBe('caller');
      }
    });

    it('none: nothing accepted, every field reported', () => {
      const explained = explainCrawlPolicy({ caller: everything }, envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'none' }));
      expect(fieldsOf(explained.policy)).toEqual(POLITE_CRAWL_POLICY);
      expect(explained.callerRejected.sort()).toEqual(Object.keys(everything).sort());
    });

    it('stricter: only values at least as polite as the policy without the caller', () => {
      const explained = explainCrawlPolicy(
        { caller: { ...everything, maxConcurrentPerHost: 1, minIntervalMs: 2000, robotsTxt: 'respect' } },
        envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' }),
      );
      expect(explained.policy).toMatchObject({
        maxConcurrentPerHost: 1,
        minIntervalMs: 2000,
        robotsTxt: 'respect',
        discovery: 'sitemap',
        userAgent: EVER_JOBS_DEFAULT_USER_AGENT,
        userAgentMode: 'identify',
        proxyRotation: 'per-host',
        retries: 2,
      });
      expect(explained.callerRejected.sort()).toEqual(['proxyRotation', 'retries', 'userAgent', 'userAgentMode']);
    });

    it('stricter is judged per host (the base includes builtin/plugin/operator layers)', () => {
      const env = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
      const caller = { maxConcurrentPerHost: 2 };
      expect(resolveCrawlPolicy({ host: 'api.greenhouse.io', caller }, env).maxConcurrentPerHost).toBe(2);
      const softy = explainCrawlPolicy({ host: 'acme.softy.pro', plugin: { maxConcurrentPerHost: 1 }, caller }, env);
      expect(softy.policy.maxConcurrentPerHost).toBe(1);
      expect(softy.callerRejected).toEqual(['maxConcurrentPerHost']);
    });

    it('a caller can never switch the egress guard off, even under "any"', () => {
      expect(CRAWL_CALLER_SECURITY_FIELDS).toContain('blockPrivateNetworks');
      const explained = explainCrawlPolicy({ caller: { blockPrivateNetworks: false } }, envOf());
      expect(explained.policy.blockPrivateNetworks).toBe(true);
      expect(explained.callerRejected).toEqual(['blockPrivateNetworks']);

      // …but the operator can, and then a caller "false" is a no-op that is accepted.
      const off = envOf({ [CRAWL_ENV.BLOCK_PRIVATE_NETWORKS]: 'false' });
      expect(resolveCrawlPolicy({ caller: { blockPrivateNetworks: false } }, off).blockPrivateNetworks).toBe(false);
      expect(resolveCrawlPolicy({ caller: { blockPrivateNetworks: true } }, off).blockPrivateNetworks).toBe(true);
    });

    it('invalid caller values are dropped with notes, never thrown', () => {
      const explained = explainCrawlPolicy(
        { caller: { retries: -1, proxyRotation: 'sometimes', nonsense: 1 } as unknown as CrawlPolicyOverride },
        envOf(),
      );
      expect(fieldsOf(explained.policy)).toEqual(POLITE_CRAWL_POLICY);
      expect(explained.notes).toHaveLength(3);
      expect(explained.notes.every((n) => n.startsWith('caller:'))).toBe(true);
    });

    it('coerces loosely typed caller values (CLI / MCP JSON)', () => {
      const resolved = resolveCrawlPolicy(
        { caller: { retries: '0', retryStatuses: '429', adaptiveThrottle: 'yes' } as unknown as CrawlPolicyOverride },
        envOf(),
      );
      expect(resolved).toMatchObject({ retries: 0, retryStatuses: [429], adaptiveThrottle: true });
    });
  });

  it('reads process.env when no env is passed', () => {
    const saved = process.env[CRAWL_ENV.RETRIES];
    process.env[CRAWL_ENV.RETRIES] = '7';
    resetCrawlPolicyEnvCache();
    try {
      const resolved = resolveCrawlPolicy({});
      expect(resolved.retries).toBe(7);
      expect(resolved.provenance.retries).toBe('env-global');
    } finally {
      if (saved === undefined) delete process.env[CRAWL_ENV.RETRIES];
      else process.env[CRAWL_ENV.RETRIES] = saved;
      resetCrawlPolicyEnvCache();
    }
  });

  it('fills provenance for every field', () => {
    const resolved = resolveCrawlPolicy({}, envOf({ [CRAWL_ENV.FROM]: 'ops@x' }));
    expect(Object.keys(resolved.provenance).sort()).toEqual([...CRAWL_POLICY_FIELDS].sort());
  });
});

describe('filterCallerOverride (Spec 1690)', () => {
  const base: CrawlPolicy = { ...POLITE_CRAWL_POLICY, from: 'ops@x' };
  const stricter = (caller: CrawlPolicyOverride, b: CrawlPolicy = base) => filterCallerOverride(caller, b, 'stricter');
  const acceptedIn = (caller: CrawlPolicyOverride, b: CrawlPolicy = base) =>
    Object.keys(stricter(caller, b).accepted).length === 1;

  it('passes undefined through as nothing', () => {
    expect(filterCallerOverride(undefined, base, 'any')).toEqual({ accepted: {}, rejected: [] });
    expect(filterCallerOverride({ retries: undefined }, base, 'none')).toEqual({ accepted: {}, rejected: [] });
  });

  it('rejects non-policy fields in every mode', () => {
    const caller = { retries: 1, bogus: 1 } as unknown as CrawlPolicyOverride;
    expect(filterCallerOverride(caller, base, 'any')).toEqual({ accepted: { retries: 1 }, rejected: ['bogus'] });
  });

  it('treats a missing mode as "any" (the documented default)', () => {
    const result = filterCallerOverride({ retries: 9 }, base, undefined as unknown as CallerOverridePolicy);
    expect(result).toEqual({ accepted: { retries: 9 }, rejected: [] });
  });

  it('treats an unknown mode as "stricter" (fail safe)', () => {
    const result = filterCallerOverride({ retries: 9, retries2: 1 } as unknown as CrawlPolicyOverride, base, 'whatever' as CallerOverridePolicy);
    expect(result.accepted).toEqual({});
    expect(result.rejected).toEqual(['retries', 'retries2']);
  });

  it('copies arrays so later mutation of the caller object cannot leak in', () => {
    const statuses = [429];
    const { accepted } = filterCallerOverride({ retryStatuses: statuses }, base, 'any');
    statuses.push(500);
    expect(accepted.retryStatuses).toEqual([429]);
  });

  // [field, accepted value(s), rejected value(s)] relative to the polite preset (+ from: ops@x).
  const TABLE: Array<[keyof CrawlPolicy, unknown[], unknown[]]> = [
    ['userAgent', [POLITE_CRAWL_POLICY.userAgent], ['Other/1.0']],
    ['from', ['ops@x'], ['other@x']],
    ['userAgentMode', ['identify', 'strict'], ['plugin']],
    ['stripClientHints', [true], [false]],
    ['proxyRotation', ['per-host', 'off'], ['per-scrape', 'per-request']],
    ['rateLimitScope', ['host', 'domain', 'site'], []],
    ['maxConcurrentPerHost', [4, 1], [5, 0]],
    ['minIntervalMs', [100, 1000], [99, 0]],
    ['jitterMs', [0, 50], []],
    ['maxQueueWaitMs', [0, 1, 999999], []],
    ['adaptiveThrottle', [true], [false]],
    ['retries', [2, 0], [3]],
    ['retryStatuses', [[429], [], [429, 502, 503, 504]], [[429, 500]]],
    ['retryBackoff', ['exponential'], ['linear', 'constant']],
    ['retryBaseDelayMs', [1000, 5000], [999]],
    ['retryMaxDelayMs', [30000, 60000], [1000]],
    ['retryJitter', [true], [false]],
    ['retryOnNetworkError', [false], [true]],
    ['respectRetryAfter', [true], [false]],
    ['maxRetryAfterMs', [1, 60000, 120000], []], // any, under give-up
    ['retryAfterOverMax', ['give-up'], ['cap']],
    ['throttleRetryDelayMs', [5000, 30000], [4999, 0]], // higher is stricter; 0 = no floor
    ['robotsTxt', ['off', 'crawl-delay', 'respect'], []],
    ['blockPrivateNetworks', [true], [false]],
    ['discovery', ['auto', 'sitemap', 'listing'], []],
  ];

  it('the table covers every CrawlPolicy field', () => {
    expect(TABLE.map(([field]) => field).sort()).toEqual([...CRAWL_POLICY_FIELDS].sort());
  });

  describe.each(TABLE)('stricter: %s', (field, ok, bad) => {
    if (ok.length > 0) {
      it.each(ok.map((v) => [v]))('accepts %j', (value) => {
        expect(acceptedIn({ [field]: value })).toBe(true);
      });
    }
    if (bad.length > 0) {
      it.each(bad.map((v) => [v]))('rejects %j', (value) => {
        expect(stricter({ [field]: value }).rejected).toEqual([field]);
      });
    }
  });

  it('rateLimitScope: host is looser than domain/site', () => {
    const domainBase = { ...base, rateLimitScope: 'domain' as const };
    expect(acceptedIn({ rateLimitScope: 'site' }, domainBase)).toBe(true);
    expect(acceptedIn({ rateLimitScope: 'host' }, domainBase)).toBe(false);
  });

  it('maxConcurrentPerHost: an unlimited (0) base accepts any cap', () => {
    const unlimited = { ...base, maxConcurrentPerHost: 0 };
    expect(acceptedIn({ maxConcurrentPerHost: 100 }, unlimited)).toBe(true);
    expect(acceptedIn({ maxConcurrentPerHost: 0 }, unlimited)).toBe(true);
  });

  it('robotsTxt: respect > crawl-delay > off', () => {
    const respect = { ...base, robotsTxt: 'respect' as const };
    expect(acceptedIn({ robotsTxt: 'crawl-delay' }, respect)).toBe(false);
    expect(acceptedIn({ robotsTxt: 'off' }, { ...base, robotsTxt: 'crawl-delay' })).toBe(false);
  });

  it('maxRetryAfterMs: higher is stricter under cap; a caller switching to give-up may set any', () => {
    const cap = { ...base, retryAfterOverMax: 'cap' as const, maxRetryAfterMs: 30000 };
    expect(acceptedIn({ maxRetryAfterMs: 60000 }, cap)).toBe(true);
    expect(acceptedIn({ maxRetryAfterMs: 1000 }, cap)).toBe(false);
    expect(stricter({ retryAfterOverMax: 'give-up', maxRetryAfterMs: 1000 }, cap).rejected).toEqual([]);
  });

  it('userAgentMode: plugin base accepts identify and strict', () => {
    const pluginBase = { ...base, userAgentMode: 'plugin' as const };
    expect(acceptedIn({ userAgentMode: 'identify' }, pluginBase)).toBe(true);
    expect(acceptedIn({ userAgentMode: 'strict' }, pluginBase)).toBe(true);
  });

  it('proxyRotation: per-request base accepts per-scrape; off and per-host are interchangeable', () => {
    const perRequest = { ...base, proxyRotation: 'per-request' as const };
    expect(acceptedIn({ proxyRotation: 'per-scrape' }, perRequest)).toBe(true);
    expect(acceptedIn({ proxyRotation: 'per-host' }, { ...base, proxyRotation: 'off' })).toBe(true);
  });

  it('retryBackoff: exponential > linear > constant', () => {
    const constant = { ...base, retryBackoff: 'constant' as const };
    expect(acceptedIn({ retryBackoff: 'linear' }, constant)).toBe(true);
    expect(acceptedIn({ retryBackoff: 'constant' }, { ...base, retryBackoff: 'linear' })).toBe(false);
  });
});

describe('normalizeCrawlOverride (Spec 1690)', () => {
  it.each([undefined, null])('%j → empty, no warnings', (raw) => {
    expect(normalizeCrawlOverride(raw)).toEqual({ value: {}, warnings: [] });
  });

  it.each([42, 'x', [1, 2], true])('%j → empty with a warning', (raw) => {
    const { value, warnings } = normalizeCrawlOverride(raw);
    expect(value).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it('validates and coerces each field', () => {
    const { value, warnings } = normalizeCrawlOverride({
      userAgent: ' Bot/1.0 ',
      userAgentMode: 'STRICT',
      proxyRotation: 'per_host',
      maxConcurrentPerHost: '3',
      minIntervalMs: 1000.7,
      retryStatuses: [429, '503', 42],
      stripClientHints: 'off',
      blockPrivateNetworks: 1,
      robotsTxt: 'Crawl Delay',
      retryAfterOverMax: 'give_up',
      from: undefined,
      jitterMs: null,
      userAgentReason: 'metadata, skipped',
      $comment: 'skipped',
      '// note': 'skipped',
      _why: 'skipped',
    });
    expect(value).toEqual({
      userAgent: 'Bot/1.0',
      userAgentMode: 'strict',
      proxyRotation: 'per-host',
      maxConcurrentPerHost: 3,
      minIntervalMs: 1000,
      retryStatuses: [429, 503],
      stripClientHints: false,
      blockPrivateNetworks: true,
      robotsTxt: 'crawl-delay',
      retryAfterOverMax: 'give-up',
    });
    expect(warnings).toEqual([
      expect.stringContaining('minIntervalMs'),
      expect.stringContaining('retryStatuses'),
    ]);
  });

  it.each([
    [{ retries: -1 }, 'retries'],
    [{ retries: 'many' }, 'retries'],
    [{ adaptiveThrottle: 'perhaps' }, 'adaptiveThrottle'],
    [{ proxyRotation: 'random' }, 'proxyRotation'],
    [{ userAgent: 42 }, 'userAgent'],
    [{ userAgent: '\r\n' }, 'userAgent'],
    [{ retryStatuses: {} }, 'retryStatuses'],
    [{ retryStatuses: [1000] }, 'retryStatuses'],
    [{ maxConcurentPerHost: 1 }, 'maxConcurentPerHost'],
  ])('%j is dropped with a warning naming %s', (raw, field) => {
    const { value, warnings } = normalizeCrawlOverride(raw);
    expect(value).toEqual({});
    expect(warnings).toEqual([expect.stringContaining(field)]);
  });

  it('accepts an empty status list (retry nothing)', () => {
    expect(normalizeCrawlOverride({ retryStatuses: [] }).value).toEqual({ retryStatuses: [] });
    expect(normalizeCrawlOverride({ retryStatuses: 'none' }).value).toEqual({ retryStatuses: [] });
  });
});

describe('matchHostPattern (Spec 1690)', () => {
  it.each([
    ['acme.softy.pro', 'acme.softy.pro', true],
    ['ACME.softy.pro', 'acme.SOFTY.pro', true],
    ['acme.softy.pro.', 'acme.softy.pro', true],
    ['acme.softy.pro', 'acme.softy.pro.', true],
    ['acme.softy.pro', 'acme.softy.pro:8443', true],
    ['acme.softy.pro', 'other.softy.pro', false],
    ['*.softy.pro', 'acme.softy.pro', true],
    ['*.softy.pro', 'a.b.softy.pro', true],
    ['*.softy.pro', 'softy.pro', false],
    ['*.softy.pro', 'evilsofty.pro', false],
    ['*.SOFTY.pro', 'Acme.Softy.Pro', true],
    ['*', 'anything.example', true],
    ['*', '', false],
    ['', 'acme.softy.pro', false],
    ['a*b.pro', 'axb.pro', false],
    ['*.', 'acme.pro', false],
    ['.softy.pro', 'acme.softy.pro', false],
  ])('(%j, %j) → %s', (pattern, host, expected) => {
    expect(matchHostPattern(pattern, host)).toBe(expected);
  });

  it('normalizes hosts and patterns', () => {
    expect(normalizeCrawlHostName(' HTTPS://Acme.Softy.Pro:443/offers ')).toBe('acme.softy.pro');
    expect(normalizeCrawlHostName('https://user:p@ss@Acme.Softy.Pro:8443/x?y#z')).toBe('acme.softy.pro');
    expect(normalizeCrawlHostName('https://acme.softy.pro\\evil.example/')).toBe('acme.softy.pro');
    expect(normalizeCrawlHostName('http://[::1]:8080/x')).toBe('[::1]');
    expect(normalizeCrawlHostName('not a url://')).toBeUndefined();
    expect(normalizeCrawlHostName('München.DE')).toBe('xn--mnchen-3ya.de');
    expect(matchHostPattern('*.münchen.de', 'jobs.xn--mnchen-3ya.de')).toBe(true);
    expect(normalizeCrawlHostName('[::1]:8080')).toBe('[::1]');
    expect(normalizeCrawlHostName('')).toBeUndefined();
    expect(normalizeCrawlHostPattern('*.Softy.Pro.')).toBe('*.softy.pro');
    expect(normalizeCrawlHostPattern('a/b')).toBeUndefined();
    expect(normalizeCrawlHostPattern('**.x')).toBeUndefined();
  });
});
