import {
  CALLER_OVERRIDES_RANK,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  gateCallerRequestTimeout,
  isSiteOwnerCallerLock,
  mostRestrictiveCallerOverrides,
} from '../src/http/crawl/caller-lock';
import {
  BUILTIN_HOST_POLICIES,
  BUILTIN_SOFTY_HOST_POLICY,
  CRAWL_ENV,
  LEGACY_BROWSER_USER_AGENT,
  POLITE_CRAWL_POLICY,
} from '../src/http/crawl/defaults';
import { CRAWL_EXTRA_ENV, readCrawlPolicyEnv } from '../src/http/crawl/env';
import {
  explainCrawlPolicy,
  isPolicyOwnedHost,
  normalizeCrawlOverride,
  resolveCallerOverrides,
} from '../src/http/crawl/resolve';
import {
  CallerOverridePolicy,
  CallerOverridesSource,
  CrawlPolicyOverride,
  CrawlPolicyResolveInput,
  PluginCrawlPolicy,
} from '../src/http/crawl/types';

/**
 * Spec 1714 — the site owner's caller lock (`callerOverrides`) and host-owned
 * policies (`*.softy.pro`). No network: pure resolution.
 *
 * Red controls: the legacy switches below are read from the test process, so
 * `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` (the manifest lock is gone) or
 * `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (the host policy is gone) make the tests
 * that depend on them fail for exactly that reason.
 */
const RED_CONTROL_VARS = [CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS, CRAWL_EXTRA_ENV.BUILTIN_HOSTS, CRAWL_EXTRA_ENV.STRICTER_RULES];

function envOf(vars: Record<string, string> = {}) {
  const fromProcess: Record<string, string> = {};
  for (const name of RED_CONTROL_VARS) {
    const value = process.env[name];
    if (value !== undefined) fromProcess[name] = value;
  }
  return readCrawlPolicyEnv({ ...fromProcess, ...vars } as NodeJS.ProcessEnv);
}

const policiesEnv = (policies: object, vars: Record<string, string> = {}) =>
  envOf({ ...vars, [CRAWL_ENV.POLICIES]: JSON.stringify(policies) });

/**
 * Inline copy of the Softy manifest as Spec 1715 §1 defines it (`SOFTY_CRAWL_POLICY`
 * belongs to the Softy plugin; this suite must not depend on a plugin package).
 */
const SOFTY_MANIFEST: PluginCrawlPolicy = {
  rateLimitScope: 'domain',
  maxConcurrentPerHost: 1,
  minIntervalMs: 1000,
  minGapMs: 500,
  callerOverrides: 'stricter',
  proxyRotation: 'per-host',
  retries: 1,
  retryStatuses: [429, 503],
  throttleRetryDelayMs: 10000,
  serverErrorCooldownMs: 30000,
  respectRetryAfter: true,
  retryAfterOverMax: 'give-up',
  userAgentMode: 'identify',
};

describe('builtin Softy host policy (Spec 1714 FR-8)', () => {
  it('is exactly the pace the site operator asked for, with a stricter lock and no identity field', () => {
    expect(BUILTIN_SOFTY_HOST_POLICY).toEqual({
      rateLimitScope: 'domain',
      maxConcurrentPerHost: 1,
      minIntervalMs: 1000,
      minGapMs: 500,
      proxyRotation: 'per-host',
      retries: 1,
      retryStatuses: [429, 503],
      throttleRetryDelayMs: 10000,
      serverErrorCooldownMs: 30000,
      respectRetryAfter: true,
      retryAfterOverMax: 'give-up',
      callerOverrides: 'stricter',
    });
    expect(BUILTIN_HOST_POLICIES['*.softy.pro']).toBe(BUILTIN_SOFTY_HOST_POLICY);
    expect(BUILTIN_HOST_POLICIES['softy.pro']).toBe(BUILTIN_SOFTY_HOST_POLICY);
    for (const field of ['userAgent', 'userAgentMode', 'from'] as const) {
      expect(BUILTIN_SOFTY_HOST_POLICY).not.toHaveProperty(field);
    }
  });

  it('agrees with the Softy manifest on every pacing / retry / lock field', () => {
    const { userAgentMode: _identity, ...manifestPacing } = SOFTY_MANIFEST;
    expect(manifestPacing).toEqual(BUILTIN_SOFTY_HOST_POLICY);
  });
});

describe('host-owned policy: every request to *.softy.pro, whichever site makes it (Spec 1714 FR-8)', () => {
  it.each(['acme.softy.pro', 'softy.pro', 'ACME.Softy.Pro.', 'https://tenant.softy.pro/offers/1', 'a.b.softy.pro'])(
    'liveness-http → %s gets the Softy pace and the builtin-host lock',
    (host) => {
      const explained = explainCrawlPolicy({ site: 'liveness-http', host }, envOf());
      expect(explained.policy).toMatchObject({
        rateLimitScope: 'domain',
        maxConcurrentPerHost: 1,
        minIntervalMs: 1000,
        minGapMs: 500,
        retries: 1,
        retryStatuses: [429, 503],
        throttleRetryDelayMs: 10000,
        serverErrorCooldownMs: 30000,
      });
      expect(explained.policy.provenance.minIntervalMs).toBe('builtin-host');
      expect(explained.callerOverrides).toBe('stricter');
      expect(explained.callerOverridesSource).toBe('builtin-host');
      expect(explained.globalCallerOverrides).toBe('any');
      expect(explained.builtinHost).toBeDefined();
      expect(explained.builtinHostPatterns).toHaveLength(1);
    },
  );

  it('the apex matches the exact pattern, a tenant the wildcard', () => {
    expect(explainCrawlPolicy({ host: 'softy.pro' }, envOf()).builtinHostPatterns).toEqual(['softy.pro']);
    expect(explainCrawlPolicy({ host: 'acme.softy.pro' }, envOf()).builtinHostPatterns).toEqual(['*.softy.pro']);
  });

  it.each(['acme.softy.pro.evil.com', 'notsofty.pro', 'softy.pro.example.org', 'xsofty.pro'])(
    'look-alike host %s is not matched',
    (host) => {
      const explained = explainCrawlPolicy({ site: 'liveness-http', host }, envOf());
      expect(explained.builtinHostPatterns).toEqual([]);
      expect(explained.builtinHost).toBeUndefined();
      expect(explained.callerOverrides).toBe('any');
      expect(explained.policy).toMatchObject({ rateLimitScope: 'host', maxConcurrentPerHost: 4, minIntervalMs: 100 });
    },
  );

  it('the JSON-LD plugin reaching a Softy page cannot be loosened by its caller', () => {
    const caller: CrawlPolicyOverride = { minIntervalMs: 0, maxConcurrentPerHost: 4, rateLimitScope: 'host' };
    const explained = explainCrawlPolicy({ site: 'jsonld', host: 'acme.softy.pro', caller }, envOf());
    expect(explained.callerRejected.sort()).toEqual(['maxConcurrentPerHost', 'minIntervalMs', 'rateLimitScope']);
    expect(explained.policy).toMatchObject({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 });
  });

  it('operator hosts / sites entries still override the builtin fields (flexibility)', () => {
    const env = policiesEnv({ hosts: { '*.softy.pro': { minIntervalMs: 3000 } }, sites: { 'liveness-http': { retries: 0 } } });
    const explained = explainCrawlPolicy({ site: 'liveness-http', host: 'acme.softy.pro' }, env);
    expect(explained.policy.minIntervalMs).toBe(3000);
    expect(explained.policy.provenance.minIntervalMs).toBe('operator-host');
    expect(explained.policy.retries).toBe(0);
    expect(explained.policy.minGapMs).toBe(500); // untouched builtin field
    expect(explained.callerOverrides).toBe('stricter'); // the operator did not touch the lock
  });

  it('EVER_JOBS_CRAWL_BUILTIN_HOSTS=false switches the host policy and its lock off (noted)', () => {
    const explained = explainCrawlPolicy(
      { site: 'liveness-http', host: 'acme.softy.pro', caller: { minIntervalMs: 0 } },
      envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'false' }),
    );
    expect(explained.policy).toMatchObject({ rateLimitScope: 'host', maxConcurrentPerHost: 4, minIntervalMs: 0 });
    expect(explained.callerOverrides).toBe('any');
    expect(explained.builtinHostPatterns).toEqual([]);
    expect(explained.notes).toEqual([expect.stringContaining('EVER_JOBS_CRAWL_BUILTIN_HOSTS=false')]);
  });
});

/**
 * Review round 2 — under the Softy lock a caller could send `proxyRotation: 'off'`:
 * the 1714 ranking called it the strictest value, so the lock accepted it, and
 * `selectProxy` then sent that caller's Softy requests from the server's own IP
 * while every other Softy request went through the operator's pinned proxy (two
 * origins — Softy's ask C). `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=base` (the
 * default) accepts only the base value, or `off` while no proxy list resolves.
 *
 * Red control: `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked` (the pre-fix order) —
 * the paired test shows the same request accepted with `off` from the caller layer.
 */
describe("a caller cannot move a locked host to another origin: proxyRotation (review round 2)", () => {
  const TWO_PROXIES = { [CRAWL_ENV.PROXIES]: 'http://p1.example:8080,http://p2.example:8080' };
  const REQUESTS: Array<[string, CrawlPolicyResolveInput, CallerOverridesSource]> = [
    ['the Softy plugin', { site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST }, 'plugin'],
    ['the JSON-LD plugin on a Softy page', { site: 'jsonld', host: 'acme.softy.pro' }, 'builtin-host'],
    ['a liveness probe of a Softy offer', { site: 'liveness-http', host: 'acme.softy.pro' }, 'builtin-host'],
  ];

  it.each(REQUESTS)("%s: a caller's 'off' is refused while env proxies are set", (_who, request, source) => {
    const explained = explainCrawlPolicy({ ...request, caller: { proxyRotation: 'off' } }, envOf(TWO_PROXIES));
    expect(explained.callerOverrides).toBe('stricter');
    expect(explained.callerOverridesSource).toBe(source);
    expect(explained.callerRejected).toEqual(['proxyRotation']);
    expect(explained.policy.proxyRotation).toBe('per-host');
    expect(explained.policy.provenance.proxyRotation).not.toBe('caller');
  });

  it.each(REQUESTS)('%s: per-scrape / per-request stay refused, per-host (the base) is accepted', (_who, request) => {
    for (const [rotation, ok] of [['per-scrape', false], ['per-request', false], ['per-host', true]] as const) {
      const explained = explainCrawlPolicy({ ...request, caller: { proxyRotation: rotation } }, envOf(TWO_PROXIES));
      expect([rotation, explained.callerRejected]).toEqual([rotation, ok ? [] : ['proxyRotation']]);
    }
  });

  it.each(REQUESTS)("%s: without any proxy list 'off' is accepted — the same direct connection", (_who, request) => {
    const explained = explainCrawlPolicy({ ...request, caller: { proxyRotation: 'off' } }, envOf());
    expect(explained.callerRejected).toEqual([]);
    expect(explained.policy.proxyRotation).toBe('off');
  });

  it.each(REQUESTS)("red control — %s: EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked accepts 'off' (the pre-fix order)", (_who, request) => {
    const explained = explainCrawlPolicy(
      { ...request, caller: { proxyRotation: 'off' } },
      envOf({ ...TWO_PROXIES, [CRAWL_EXTRA_ENV.CALLER_PROXY_ROTATION]: 'ranked' }),
    );
    expect(explained.callerOverrides).toBe('stricter');
    expect(explained.callerRejected).toEqual([]);
    expect(explained.policy.proxyRotation).toBe('off');
    expect(explained.policy.provenance.proxyRotation).toBe('caller');
  });

  it('an unlocked source (global any) still takes any caller rotation, proxies or not (rule 3)', () => {
    for (const vars of [{}, TWO_PROXIES]) {
      const explained = explainCrawlPolicy({ site: 'linkedin', host: 'www.linkedin.com', caller: { proxyRotation: 'off' } }, envOf(vars));
      expect(explained.callerOverrides).toBe('any');
      expect(explained.callerRejected).toEqual([]);
      expect(explained.policy.proxyRotation).toBe('off');
    }
  });

  it('the legacy preset keeps the pre-fix order (with its 1690 comparators)', () => {
    const explained = explainCrawlPolicy(
      { site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST, caller: { proxyRotation: 'off' } },
      envOf({ ...TWO_PROXIES, [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS]: 'true' }),
    );
    expect(explained.callerOverrides).toBe('stricter');
    expect(explained.callerRejected).toEqual([]);
  });
});

describe('EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE — drop only some builtin entries (Spec 1715 audit F3)', () => {
  const DISABLE_SOFTY = { [CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE]: '*.softy.pro,softy.pro' };

  it.each(['acme.softy.pro', 'softy.pro'])('%s: the generic limits and no lock, as before Spec 1714 (noted)', (host) => {
    const explained = explainCrawlPolicy({ site: 'liveness-http', host, caller: { minIntervalMs: 0 } }, envOf(DISABLE_SOFTY));
    expect(explained.policy).toMatchObject({ rateLimitScope: 'host', maxConcurrentPerHost: 4, minIntervalMs: 0, minGapMs: 0 });
    expect(explained.callerOverrides).toBe('any');
    expect(explained.callerOverridesSource).toBe('default');
    expect(explained.builtinHostPatterns).toEqual([]);
    expect(explained.builtinHost).toBeUndefined();
    expect(explained.builtinHostPatternsDisabled).toEqual([host === 'softy.pro' ? 'softy.pro' : '*.softy.pro']);
    expect(explained.notes).toEqual([expect.stringContaining(CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE)]);
    expect(resolveCallerOverrides({ site: 'liveness-http', host }, envOf(DISABLE_SOFTY))).toEqual({
      mode: 'any',
      source: 'default',
      global: 'any',
    });
  });

  it('keeps the pre-1714 bulk-API limits — unlike EVER_JOBS_CRAWL_BUILTIN_HOSTS=false (the red control)', () => {
    const kept = explainCrawlPolicy({ site: 'greenhouse', host: 'boards-api.greenhouse.io' }, envOf(DISABLE_SOFTY));
    expect(kept.policy).toMatchObject({ maxConcurrentPerHost: 16, minIntervalMs: 0 });
    expect(kept.policy.provenance.maxConcurrentPerHost).toBe('builtin-host');
    expect(kept.builtinHostPatterns).toEqual(['boards-api.greenhouse.io']);
    expect(kept.builtinHostPatternsDisabled).toEqual([]);

    // The only switch before Spec 1715: it drops Greenhouse's limits too (16 / 0 ms → 4 / 100 ms).
    const allOff = explainCrawlPolicy(
      { site: 'greenhouse', host: 'boards-api.greenhouse.io' },
      envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'false' }),
    );
    expect(allOff.policy).toMatchObject({ maxConcurrentPerHost: 4, minIntervalMs: 100 });
  });

  it('disabling only the apex leaves every tenant under the Softy policy and lock', () => {
    const env = envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE]: 'softy.pro' });
    expect(explainCrawlPolicy({ host: 'acme.softy.pro' }, env).callerOverrides).toBe('stricter');
    expect(explainCrawlPolicy({ host: 'softy.pro' }, env).callerOverrides).toBe('any');
  });

  it('the Softy plugin keeps its own manifest (a plugin layer, not a builtin entry)', () => {
    const explained = explainCrawlPolicy({ site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST }, envOf(DISABLE_SOFTY));
    expect(explained.policy).toMatchObject({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 });
    expect(explained.callerOverridesSource).toBe('plugin');
  });

  it('the whole-layer switch wins: with EVER_JOBS_CRAWL_BUILTIN_HOSTS=false nothing is "disabled" per pattern', () => {
    const explained = explainCrawlPolicy(
      { host: 'acme.softy.pro' },
      envOf({ ...DISABLE_SOFTY, [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'false' }),
    );
    expect(explained.builtinHostPatternsDisabled).toEqual([]);
    expect(explained.notes).toEqual([expect.stringContaining('EVER_JOBS_CRAWL_BUILTIN_HOSTS=false')]);
  });
});

describe('isPolicyOwnedHost — a redirect hop to it is paced on its own (Spec 1715 audit A0)', () => {
  it.each([
    ['acme.softy.pro', true],
    ['https://acme.softy.pro/offers/1', true],
    ['softy.pro', true],
    ['boards-api.greenhouse.io', false], // builtin, but neither a lock nor a domain scope
    ['www.example.com', false],
    ['not a host', false],
    [undefined, false],
  ] as const)('%s → %s', (host, expected) => {
    expect(isPolicyOwnedHost(host, envOf())).toBe(expected);
  });

  it('an operator hosts entry with a lock or a domain scope owns its hosts; pacing alone does not', () => {
    const env = policiesEnv({
      hosts: {
        'jobs.locked.example': { callerOverrides: 'stricter' },
        '*.none.example': { callerOverrides: 'none' },
        '*.shared.example': { rateLimitScope: 'domain' },
        'slow.example': { minIntervalMs: 5000 },
        'open.example': { callerOverrides: 'any' },
      },
    });
    expect(isPolicyOwnedHost('jobs.locked.example', env)).toBe(true);
    expect(isPolicyOwnedHost('a.none.example', env)).toBe(true);
    expect(isPolicyOwnedHost('t1.shared.example', env)).toBe(true);
    expect(isPolicyOwnedHost('slow.example', env)).toBe(false);
    expect(isPolicyOwnedHost('open.example', env)).toBe(false);
  });

  it('follows EVER_JOBS_CRAWL_BUILTIN_HOSTS and _BUILTIN_HOSTS_DISABLE', () => {
    expect(isPolicyOwnedHost('acme.softy.pro', envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'false' }))).toBe(false);
    expect(isPolicyOwnedHost('acme.softy.pro', envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE]: '*.softy.pro' }))).toBe(false);
    expect(isPolicyOwnedHost('softy.pro', envOf({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE]: '*.softy.pro' }))).toBe(true);
  });
});

describe('the Softy manifest lock under the default global "any" (Spec 1714 FR-1/FR-2, gaps G0 G3 G5 G9 G12 G22)', () => {
  // No host: only the plugin lock applies (the builtin host layer is tested above).
  const input = (caller: CrawlPolicyOverride): CrawlPolicyResolveInput => ({ site: 'softy', plugin: SOFTY_MANIFEST, caller });

  it.each([
    ['userAgentMode', 'plugin'],
    ['userAgent', 'browser'],
    ['from', 'someone@example.com'],
    ['proxyRotation', 'per-request'],
    ['rateLimitScope', 'site'],
    ['minIntervalMs', 0],
    ['maxConcurrentPerHost', 0],
    ['respectRetryAfter', false],
    ['retries', 10],
    ['retryStatuses', [500]],
    ['discovery', 'listing'],
    ['minGapMs', 0],
    ['serverErrorCooldownMs', 0],
    ['adaptiveThrottle', false],
    ['retryAfterOverMax', 'cap'],
    ['throttleRetryDelayMs', 0],
  ] as const)('refuses a caller %s: %j', (field, value) => {
    const explained = explainCrawlPolicy(input({ [field]: value } as CrawlPolicyOverride), envOf());
    expect(explained.callerOverrides).toBe('stricter');
    expect(explained.callerOverridesSource).toBe('plugin');
    expect(explained.callerRejected).toEqual([field]);
    expect(explained.policy.provenance[field]).not.toBe('caller');
  });

  it.each([
    ['minIntervalMs', 2000],
    ['userAgentMode', 'strict'],
    ['discovery', 'sitemap'],
    ['minGapMs', 1000],
    ['retries', 0],
    ['maxConcurrentPerHost', 1],
    ['proxyRotation', 'off'],
    ['retryStatuses', [429, 503]],
  ] as const)('accepts a more polite caller %s: %j', (field, value) => {
    const explained = explainCrawlPolicy(input({ [field]: value } as CrawlPolicyOverride), envOf());
    expect(explained.callerRejected).toEqual([]);
    expect(explained.policy[field]).toEqual(value);
    expect(explained.policy.provenance[field]).toBe('caller');
  });

  it('notes that the lock tightened the global mode', () => {
    const explained = explainCrawlPolicy(input({}), envOf());
    expect(explained.notes).toEqual([expect.stringMatching(/caller overrides "stricter" \(set by plugin\).*"any"/)]);
  });

  it('the lock of a plugin that reaches its own host is reported with the host pattern', () => {
    const explained = explainCrawlPolicy({ ...input({}), host: 'acme.softy.pro' }, envOf());
    expect(explained.callerOverrides).toBe('stricter');
    expect(explained.callerOverridesSource).toBe('plugin'); // a tie: the higher layer is the source
    expect(explained.builtinHostPatterns).toEqual(['*.softy.pro']);
  });

  it('a lock in the client options (createHttpClient crawl) works like a manifest lock', () => {
    const explained = explainCrawlPolicy(
      { site: 'x', explicit: { callerOverrides: 'none' }, caller: { retries: 0 } },
      envOf(),
    );
    expect(explained).toMatchObject({ callerOverrides: 'none', callerOverridesSource: 'plugin', callerRejected: ['retries'] });
  });

  it('client options cannot loosen the manifest lock', () => {
    const lock = resolveCallerOverrides({ site: 'softy', plugin: SOFTY_MANIFEST, explicit: { callerOverrides: 'any' } }, envOf());
    expect(lock).toEqual({ mode: 'stricter', source: 'plugin', global: 'any' });
  });

  it('without the lock (a manifest that sets none) the same caller is accepted — the golden "any" path', () => {
    const { callerOverrides: _lock, ...unlocked } = SOFTY_MANIFEST;
    const explained = explainCrawlPolicy(
      { site: 'softy', plugin: unlocked, caller: { minIntervalMs: 0, proxyRotation: 'per-request' } },
      envOf(),
    );
    expect(explained.callerOverrides).toBe('any');
    expect(explained.callerOverridesSource).toBe('default');
    expect(explained.callerRejected).toEqual([]);
    expect(explained.notes).toEqual([]);
  });
});

describe('operator values replace the effective mode; the global mode is the floor for locks (Spec 1714 FR-2)', () => {
  const softy = (host?: string, caller: CrawlPolicyOverride = { minIntervalMs: 0 }): CrawlPolicyResolveInput => ({
    site: 'softy',
    host,
    plugin: SOFTY_MANIFEST,
    caller,
  });

  it('operator sites.softy.callerOverrides "any" loosens the lock (the operator decides)', () => {
    const env = policiesEnv({ sites: { softy: { callerOverrides: 'any' } } });
    const explained = explainCrawlPolicy(softy(), env);
    expect(explained).toMatchObject({ callerOverrides: 'any', callerOverridesSource: 'operator-site', callerRejected: [] });
    expect(explained.policy.minIntervalMs).toBe(0);

    // Red control: without the operator entry, the plugin lock returns.
    expect(explainCrawlPolicy(softy(), envOf())).toMatchObject({ callerOverrides: 'stricter', callerRejected: ['minIntervalMs'] });
  });

  it('operator hosts["*.softy.pro"] "none" tightens it', () => {
    const env = policiesEnv({ hosts: { '*.softy.pro': { callerOverrides: 'none' } } });
    const explained = explainCrawlPolicy(softy('acme.softy.pro', { minIntervalMs: 5000 }), env);
    expect(explained).toMatchObject({ callerOverrides: 'none', callerOverridesSource: 'operator-host', callerRejected: ['minIntervalMs'] });
  });

  it('an operator host value beats the operator site value; the most specific host pattern wins', () => {
    const env = policiesEnv({
      sites: { softy: { callerOverrides: 'any' } },
      hosts: { '*.softy.pro': { callerOverrides: 'none' }, 'acme.softy.pro': { callerOverrides: 'stricter' } },
    });
    expect(resolveCallerOverrides(softy('beta.softy.pro'), env)).toEqual({ mode: 'none', source: 'operator-host', global: 'any' });
    expect(resolveCallerOverrides(softy('acme.softy.pro'), env)).toEqual({ mode: 'stricter', source: 'operator-host', global: 'any' });
    expect(resolveCallerOverrides(softy(), env)).toEqual({ mode: 'any', source: 'operator-site', global: 'any' });
  });

  it('the full operator undo documented in the spec gives the pre-1714 caller freedom on Softy hosts', () => {
    const env = policiesEnv({
      sites: { softy: { callerOverrides: 'any' } },
      hosts: { '*.softy.pro': { callerOverrides: 'any' }, 'softy.pro': { callerOverrides: 'any' } },
    });
    for (const input of [softy('acme.softy.pro'), softy('softy.pro'), { site: 'liveness-http', host: 'acme.softy.pro', caller: { minIntervalMs: 0 } }]) {
      const explained = explainCrawlPolicy(input, env);
      expect(explained.callerOverrides).toBe('any');
      expect(explained.callerRejected).toEqual([]);
    }
  });

  it('global "none" + plugin "stricter" = "none" from env-global', () => {
    const env = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'none' });
    expect(resolveCallerOverrides(softy(), env)).toEqual({ mode: 'none', source: 'env-global', global: 'none' });
  });

  it('a plugin "any" cannot loosen a global "stricter"', () => {
    const env = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
    const lock = resolveCallerOverrides({ site: 'x', plugin: { callerOverrides: 'any' } }, env);
    expect(lock).toEqual({ mode: 'stricter', source: 'env-global', global: 'stricter' });
  });

  it('global "stricter" + plugin "stricter": on a tie the higher layer (plugin) is the source', () => {
    const env = envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
    expect(resolveCallerOverrides(softy(), env)).toEqual({ mode: 'stricter', source: 'plugin', global: 'stricter' });
  });

  it('the lock ignores an invalid operator / manifest value (with a note), never throws', () => {
    const env = policiesEnv({ sites: { softy: { callerOverrides: 'lenient' } } });
    expect(env.warnings).toEqual([expect.stringContaining('callerOverrides')]);
    expect(resolveCallerOverrides(softy(), env).mode).toBe('stricter');
    const explained = explainCrawlPolicy({ site: 'x', plugin: { callerOverrides: 'bogus' } as unknown as PluginCrawlPolicy }, envOf());
    expect(explained.callerOverrides).toBe('any');
    expect(explained.notes).toEqual([expect.stringContaining('callerOverrides')]);
  });

  it('under the legacy preset (no manifests, no builtin hosts) there is no lock', () => {
    const env = envOf({ [CRAWL_ENV.PRESET]: 'legacy' });
    expect(resolveCallerOverrides(softy('acme.softy.pro'), env)).toEqual({ mode: 'any', source: 'default', global: 'any' });
  });
});

describe('a caller can never send a lock (Spec 1714 FR-1)', () => {
  it.each(['any', 'stricter', 'none'] as const)('callerOverrides from a caller is refused under global %s', (global) => {
    const explained = explainCrawlPolicy(
      { site: 'softy', plugin: SOFTY_MANIFEST, caller: { callerOverrides: 'any' } },
      envOf({ [CRAWL_ENV.CALLER_OVERRIDES]: global }),
    );
    expect(explained.callerRejected).toEqual(['callerOverrides']);
    expect(explained.callerOverrides).toBe(global === 'none' ? 'none' : 'stricter');
    expect(explained.policy).not.toHaveProperty('callerOverrides');
  });

  it('the lock is never a field of the resolved policy', () => {
    const explained = explainCrawlPolicy({ site: 'liveness-http', host: 'acme.softy.pro' }, envOf());
    expect(explained.policy).not.toHaveProperty('callerOverrides');
    expect(explained.policy.provenance).not.toHaveProperty('callerOverrides');
  });
});

describe('resolveCallerOverrides agrees with explainCrawlPolicy', () => {
  const env = policiesEnv({ hosts: { '*.jobs.example': { callerOverrides: 'none' } } });
  it.each<[string, CrawlPolicyResolveInput]>([
    ['linkedin', { site: 'linkedin', host: 'www.linkedin.com' }],
    ['softy manifest', { site: 'softy', plugin: SOFTY_MANIFEST }],
    ['softy tenant', { site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST }],
    ['liveness on softy', { site: 'liveness-http', host: 'x.softy.pro' }],
    ['operator host', { site: 'y', host: 'a.jobs.example' }],
  ])('%s', (_name, input) => {
    const explained = explainCrawlPolicy(input, env);
    expect(resolveCallerOverrides(input, env)).toEqual({
      mode: explained.callerOverrides,
      source: explained.callerOverridesSource,
      global: explained.globalCallerOverrides,
    });
  });
});

describe('baseRateLimitScope (Spec 1714 FR-6)', () => {
  it('is the scope before the caller layer', () => {
    const env = policiesEnv({ sites: { s: { rateLimitScope: 'domain' } } });
    const explained = explainCrawlPolicy({ site: 's', host: 't1.x.example', caller: { rateLimitScope: 'host' } }, env);
    expect(explained.policy.rateLimitScope).toBe('host'); // accepted under "any"
    expect(explained.baseRateLimitScope).toBe('domain');
  });
});

describe('normalizeCrawlOverride keeps a valid lock (Spec 1714)', () => {
  it.each([
    ['stricter', 'stricter'],
    ['NONE', 'none'],
    [' Any ', 'any'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeCrawlOverride({ callerOverrides: raw })).toEqual({ value: { callerOverrides: expected }, warnings: [] });
  });

  it('drops an invalid lock with a warning', () => {
    const { value, warnings } = normalizeCrawlOverride({ callerOverrides: 'lenient', retries: 1 });
    expect(value).toEqual({ retries: 1 });
    expect(warnings).toEqual([expect.stringContaining('callerOverrides')]);
  });
});

describe('caller-lock helpers (Spec 1714)', () => {
  it('ranks any < stricter < none', () => {
    expect(CALLER_OVERRIDES_RANK).toEqual({ any: 0, stricter: 1, none: 2 });
  });

  it.each<[Array<CallerOverridePolicy | undefined>, CallerOverridePolicy | undefined]>([
    [[], undefined],
    [[undefined, undefined], undefined],
    [['any'], 'any'],
    [['any', 'stricter'], 'stricter'],
    [['none', 'stricter', 'any'], 'none'],
    [[undefined, 'stricter', undefined], 'stricter'],
    [['bogus' as CallerOverridePolicy, 'any'], 'any'],
  ])('mostRestrictiveCallerOverrides(%j) → %j', (modes, expected) => {
    expect(mostRestrictiveCallerOverrides(...modes)).toBe(expected);
  });

  // Spec 1715 audit A1: a site owner's lock = stricter / none, decided by the plugin or a builtin host policy.
  it.each<[CallerOverridePolicy, CallerOverridesSource, boolean]>([
    ['stricter', 'plugin', true],
    ['none', 'plugin', true],
    ['stricter', 'builtin-host', true],
    ['none', 'builtin-host', true],
    ['any', 'plugin', false],
    ['any', 'builtin-host', false],
    ['stricter', 'env-global', false],
    ['none', 'env-global', false],
    ['stricter', 'operator-site', false],
    ['stricter', 'operator-host', false],
    ['any', 'default', false],
  ])('isSiteOwnerCallerLock(%s from %s) → %s', (mode, source, expected) => {
    expect(isSiteOwnerCallerLock({ mode, source })).toBe(expected);
  });

  it('isSiteOwnerCallerLock is false for nothing, and agrees with resolveCallerOverrides for Softy', () => {
    expect(isSiteOwnerCallerLock(undefined)).toBe(false);
    expect(isSiteOwnerCallerLock(null)).toBe(false);
    expect(isSiteOwnerCallerLock(resolveCallerOverrides({ site: 'softy', plugin: SOFTY_MANIFEST }, envOf()))).toBe(true);
    expect(isSiteOwnerCallerLock(resolveCallerOverrides({ site: 'jsonld', host: 'acme.softy.pro' }, envOf()))).toBe(true);
    // An operator loosening it back: the operator's choice, not a lock.
    const unlocked = resolveCallerOverrides(
      { site: 'softy', plugin: SOFTY_MANIFEST },
      policiesEnv({ sites: { softy: { callerOverrides: 'any' } } }),
    );
    expect(isSiteOwnerCallerLock(unlocked)).toBe(false);
  });
});

describe('gateCallerRequestTimeout (Spec 1714 FR-7, audit K3)', () => {
  const D = DEFAULT_REQUEST_TIMEOUT_SECONDS;

  it('the default is the ScraperInputDto default (60 s)', () => {
    expect(D).toBe(60);
  });

  // [mode, requested, value, accepted]
  it.each<[CallerOverridePolicy, unknown, number | undefined, boolean]>([
    ['any', 0.2, 0.2, true],
    ['any', 60, 60, true],
    ['any', 120, 120, true],
    ['any', undefined, undefined, true],
    ['any', NaN, NaN, true],
    ['stricter', 0.2, D, false],
    ['stricter', 60, 60, true],
    ['stricter', 120, 120, true],
    ['stricter', undefined, D, true],
    ['stricter', NaN, D, false],
    ['stricter', Infinity, D, false],
    ['none', 0.2, D, false],
    ['none', 60, D, true],
    ['none', 120, D, false],
    ['none', undefined, D, true],
    ['none', NaN, D, false],
  ])('%s, requested %j → %j (accepted %j)', (mode, requested, value, accepted) => {
    const decision = gateCallerRequestTimeout(requested, mode);
    expect(decision.value).toEqual(value);
    expect(decision.accepted).toBe(accepted);
    if (!accepted) expect(decision.note).toEqual(expect.stringContaining('requestTimeout'));
    else expect(decision.note).toBeUndefined();
  });

  it('judges against the resolved default it is given', () => {
    expect(gateCallerRequestTimeout(45, 'stricter', 30)).toEqual({ value: 45, accepted: true });
    expect(gateCallerRequestTimeout(20, 'stricter', 30)).toMatchObject({ value: 30, accepted: false });
    expect(gateCallerRequestTimeout(20, 'stricter', NaN)).toMatchObject({ value: D, accepted: false });
  });

  it('an unknown mode is treated as stricter (fail safe)', () => {
    expect(gateCallerRequestTimeout(0.2, 'whatever' as CallerOverridePolicy)).toMatchObject({ value: D, accepted: false });
  });

  it.each<[CallerOverridePolicy, unknown]>([
    ['stricter', 0.2],
    ['none', 0.2],
    ['none', 120],
    ['stricter', undefined],
  ])('rules "1690" (EVER_JOBS_CRAWL_STRICTER_RULES=1690) passes %s / %j through unchanged', (mode, requested) => {
    expect(gateCallerRequestTimeout(requested, mode, D, '1690')).toEqual({ value: requested, accepted: true });
  });
});

describe('the caller-sent UA of G0 never reaches a locked source', () => {
  it('"browser" (the Chrome/120 string) is refused for Softy under the default install', () => {
    const explained = explainCrawlPolicy(
      { site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_MANIFEST, caller: { userAgent: 'browser', userAgentMode: 'strict' } },
      envOf(),
    );
    expect(explained.callerRejected).toEqual(['userAgent']);
    expect(explained.policy.userAgent).not.toBe(LEGACY_BROWSER_USER_AGENT);
    expect(explained.policy.userAgent).toBe(POLITE_CRAWL_POLICY.userAgent);
    expect(explained.policy.userAgentMode).toBe('strict'); // the only accepted identity change
  });
});
