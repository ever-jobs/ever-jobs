import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IScraper, JobResponseDto, Site } from '@ever-jobs/models';
import {
  BUILTIN_SOFTY_HOST_POLICY,
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  POLITE_CRAWL_POLICY,
  PluginCrawlPolicy,
  resetCrawlPolicyEnvCache,
} from '@ever-jobs/common';
import { IPluginMetadata, PluginRegistry, SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { SoftyService } from '@ever-jobs/source-ats-softy';
import { LIVENESS_CRAWL_SITE } from '../crawl-policy.mapping';
import {
  SourcesHealthController,
  clientMinIntervalFloorMs,
  effectiveClientMinIntervalFloorMs,
  redactCredentials,
} from '../health.controller';

/**
 * Spec 1690 §5.4 — `GET /api/sources/:site/crawl-policy?host=`: the resolved
 * policy with provenance, the plugin's UA reason and env warnings; 404 for an
 * unknown site; read-only.
 */

const scraper: IScraper = { scrape: async () => new JobResponseDto([]) };

function registryWith(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    {
      site: Site.SOFTY,
      name: 'Softy',
      category: 'ats',
      isAts: true,
      crawl: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 },
    },
    scraper,
  );
  registry.register(
    {
      site: Site.USAJOBS,
      name: 'USAJobs',
      category: 'government',
      crawl: { userAgentMode: 'plugin', userAgentReason: 'The API requires the registered e-mail as its User-Agent.' },
    },
    scraper,
  );
  registry.registerExternal('community-board', scraper);
  return registry;
}

const ENV_KEYS = [
  CRAWL_ENV.CALLER_OVERRIDES,
  CRAWL_ENV.POLICIES,
  CRAWL_ENV.PRESET,
  CRAWL_ENV.PROXIES,
  // Spec 1714
  CRAWL_EXTRA_ENV.FLEET_SIZE,
  CRAWL_EXTRA_ENV.BUILTIN_HOSTS,
  // Spec 1715
  CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE,
  // Spec 1715 review round 2
  CRAWL_EXTRA_ENV.STRICTER_RULES,
  CRAWL_EXTRA_ENV.PROXY_PIN_SCOPE,
  CRAWL_EXTRA_ENV.ROBOTS_BACKOFF,
  CRAWL_EXTRA_ENV.PACE_REDIRECTS,
  CRAWL_EXTRA_ENV.CALLER_PROXY_ROTATION,
  'SOFTY_LEGACY',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetCrawlPolicyEnvCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCrawlPolicyEnvCache();
});

describe('SourcesHealthController.crawlPolicy (Spec 1690 §5.4)', () => {
  const controller = () => new SourcesHealthController(undefined, registryWith());

  it('404s for a site that is neither a Site nor a registered plugin', () => {
    expect(() => controller().crawlPolicy('no-such-source')).toThrow(NotFoundException);
    expect(() => new SourcesHealthController().crawlPolicy('no-such-source')).toThrow(NotFoundException);
  });

  it('returns the site-level policy with provenance for a known Site (no registry needed)', () => {
    const res = new SourcesHealthController().crawlPolicy(Site.LINKEDIN);
    expect(res.site).toBe(Site.LINKEDIN);
    expect(res.host).toBeNull();
    expect(res.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    expect(res.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
    expect(res.provenance.userAgent).toBe('preset');
    expect(res.provenance.maxConcurrentPerHost).toBe('preset');
    expect(res.meta).toMatchObject({ preset: 'polite', callerOverrides: 'any', plugin: null });
    expect(res.userAgentReason).toBeUndefined();
  });

  it("applies the plugin's @SourcePlugin({ crawl }) and reports it", () => {
    const res = controller().crawlPolicy(Site.SOFTY);
    expect(res).toMatchObject({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 });
    expect(res.provenance).toMatchObject({
      rateLimitScope: 'plugin',
      maxConcurrentPerHost: 'plugin',
      minIntervalMs: 'plugin',
      userAgent: 'preset',
    });
    expect(res.meta.plugin).toEqual({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 });
  });

  it("surfaces the plugin's userAgentReason when its UA opt-in is in effect", () => {
    const res = controller().crawlPolicy(Site.USAJOBS);
    expect(res.userAgentMode).toBe('plugin');
    expect(res.userAgentReason).toBe('The API requires the registered e-mail as its User-Agent.');
  });

  it('serves registered plugins outside the Site enum (external plugins)', () => {
    expect(controller().crawlPolicy('community-board').site).toBe('community-board');
  });

  it('resolves host-specific layers for ?host= (hostname, URL or host/path)', () => {
    const bulk = controller().crawlPolicy(Site.GREENHOUSE, 'https://Boards-API.Greenhouse.io/v1/boards/acme/jobs');
    expect(bulk.host).toBe('boards-api.greenhouse.io');
    expect(bulk.meta.builtinHost).toBe('boards-api.greenhouse.io');
    expect(bulk.provenance.maxConcurrentPerHost).toBe('builtin-host');

    expect(controller().crawlPolicy(Site.SOFTY, 'acme.softy.pro/offers?page=2').host).toBe('acme.softy.pro');
  });

  it('applies operator per-site and per-host policies, host winning', () => {
    process.env[CRAWL_ENV.POLICIES] = JSON.stringify({
      sites: { softy: { minIntervalMs: 2000, discovery: 'sitemap' } },
      hosts: { '*.softy.pro': { minIntervalMs: 3000 } },
    });
    resetCrawlPolicyEnvCache();

    const res = controller().crawlPolicy(Site.SOFTY, 'acme.softy.pro');
    expect(res.minIntervalMs).toBe(3000);
    expect(res.provenance.minIntervalMs).toBe('operator-host');
    expect(res.discovery).toBe('sitemap');
    expect(res.provenance.discovery).toBe('operator-site');
    expect(res.meta.operatorSite).toBe('softy');
    expect(res.meta.operatorHostPatterns).toEqual(['*.softy.pro']);
  });

  it('400s for an unusable host', () => {
    expect(() => controller().crawlPolicy(Site.SOFTY, 'acme softy.pro')).toThrow(BadRequestException);
    expect(() => controller().crawlPolicy(Site.SOFTY, 'http://')).toThrow(BadRequestException);
  });

  it('previews a caller override (?crawl=) and lists what the caller-override rule refused', () => {
    const accepted = controller().crawlPolicy(Site.LINKEDIN, undefined, '{"maxConcurrentPerHost":2,"discovery":"listing"}');
    expect(accepted.maxConcurrentPerHost).toBe(2);
    expect(accepted.provenance.maxConcurrentPerHost).toBe('caller');
    expect(accepted.meta.caller).toEqual({ rejected: [] });

    process.env[CRAWL_ENV.CALLER_OVERRIDES] = 'stricter';
    resetCrawlPolicyEnvCache();
    const refused = controller().crawlPolicy(Site.LINKEDIN, undefined, '{"maxConcurrentPerHost":50,"minIntervalMs":5000}');
    expect(refused.meta.callerOverrides).toBe('stricter');
    expect(refused.meta.caller!.rejected).toEqual(['maxConcurrentPerHost']);
    expect(refused.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
    expect(refused.minIntervalMs).toBe(5000);
  });

  it('400s for a crawl preview that is not a JSON object', () => {
    expect(() => controller().crawlPolicy(Site.LINKEDIN, undefined, '{nope')).toThrow(BadRequestException);
    expect(() => controller().crawlPolicy(Site.LINKEDIN, undefined, '[1,2]')).toThrow(BadRequestException);
    expect(() => controller().crawlPolicy(Site.LINKEDIN, undefined, '"polite"')).toThrow(BadRequestException);
  });

  it('reports env warnings and never echoes proxy credentials or the proxy list', () => {
    process.env[CRAWL_ENV.POLICIES] = '{not json';
    process.env[CRAWL_ENV.PROXIES] = 'http://user:s3cret@proxy.example:8080';
    resetCrawlPolicyEnvCache();

    const res = controller().crawlPolicy(Site.LINKEDIN);
    expect(res.warnings.some((w) => w.includes(CRAWL_ENV.POLICIES))).toBe(true);
    expect(res.meta.envProxyCount).toBe(1);
    expect(JSON.stringify(res)).not.toContain('s3cret');
  });

  it(`serves the API's own crawl pseudo-sites (${LIVENESS_CRAWL_SITE}) and operator-configured site keys`, () => {
    process.env[CRAWL_ENV.POLICIES] = JSON.stringify({
      sites: { [LIVENESS_CRAWL_SITE]: { maxConcurrentPerHost: 2 }, 'My-Batch': { retries: 0 } },
    });
    resetCrawlPolicyEnvCache();

    const liveness = controller().crawlPolicy(LIVENESS_CRAWL_SITE);
    expect(liveness.site).toBe(LIVENESS_CRAWL_SITE);
    expect(liveness.maxConcurrentPerHost).toBe(2);
    expect(liveness.provenance.maxConcurrentPerHost).toBe('operator-site');
    expect(new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE).site).toBe(LIVENESS_CRAWL_SITE);
    expect(controller().crawlPolicy('my-batch').retries).toBe(0);
    expect(() => controller().crawlPolicy('still-unknown')).toThrow(NotFoundException);
  });

  it('a pseudo-site resolves with no operator policy too (the global policy)', () => {
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE);
    expect(res.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
    expect(res.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('a hostile ?crawl= key is echoed cut short and cheaply (no quadratic redaction)', () => {
    const key = '=a:'.repeat(5400);
    const started = Date.now();
    const res = controller().crawlPolicy(Site.LINKEDIN, undefined, JSON.stringify({ [key]: 1 }));
    expect(Date.now() - started).toBeLessThan(200);
    const note = res.warnings.find((w) => w.includes('unknown crawl-policy field'))!;
    expect(note.length).toBeLessThan(200);
  });
});

/**
 * Spec 1714 FR-3 — the policy API shows the EFFECTIVE caller-override mode, the layer that
 * decided it, the global mode, the builtin host patterns applied and the fleet size.
 */
describe('SourcesHealthController.crawlPolicy — caller lock and fleet size (Spec 1714)', () => {
  /** The Softy manifest as Spec 1715 ships it (the lock is the part under test). */
  const SOFTY_MANIFEST: PluginCrawlPolicy = {
    rateLimitScope: 'domain',
    maxConcurrentPerHost: 1,
    minIntervalMs: 1000,
    minGapMs: 500,
    callerOverrides: 'stricter',
  };

  function lockedController(): SourcesHealthController {
    const registry = new PluginRegistry();
    registry.register({ site: Site.SOFTY, name: 'Softy', category: 'ats', isAts: true, crawl: SOFTY_MANIFEST }, scraper);
    return new SourcesHealthController(undefined, registry);
  }

  it('softy: the plugin lock tightens the global "any" to "stricter"', () => {
    const res = lockedController().crawlPolicy(Site.SOFTY);
    expect(res.meta).toMatchObject({
      callerOverrides: 'stricter',
      callerOverridesProvenance: 'plugin',
      globalCallerOverrides: 'any',
      builtinHostPatterns: [],
      fleetSize: 1,
    });
    // The lock is not a policy field.
    expect(res).not.toHaveProperty('callerOverrides');
    expect(res.minGapMs).toBe(500);
    expect(res.provenance.minGapMs).toBe('plugin');
  });

  it('softy?host=acme.softy.pro: the builtin *.softy.pro pattern applies too; the plugin (higher layer) is the source on the tie', () => {
    const res = lockedController().crawlPolicy(Site.SOFTY, 'acme.softy.pro');
    expect(res.meta).toMatchObject({
      callerOverrides: 'stricter',
      callerOverridesProvenance: 'plugin',
      builtinHostPatterns: ['*.softy.pro'],
      builtinHost: 'acme.softy.pro',
    });
    expect(res.serverErrorCooldownMs).toBe(BUILTIN_SOFTY_HOST_POLICY.serverErrorCooldownMs);
    expect(res.provenance.serverErrorCooldownMs).toBe('builtin-host');
  });

  it('liveness-http?host=acme.softy.pro: the builtin host policy locks the pseudo-site and paces it like Softy', () => {
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(res.meta).toMatchObject({
      callerOverrides: 'stricter',
      callerOverridesProvenance: 'builtin-host',
      globalCallerOverrides: 'any',
      builtinHostPatterns: ['*.softy.pro'],
    });
    expect(res).toMatchObject({
      rateLimitScope: 'domain',
      maxConcurrentPerHost: 1,
      minIntervalMs: 1000,
      minGapMs: 500,
      serverErrorCooldownMs: 30000,
    });
    expect(res.provenance.minGapMs).toBe('builtin-host');
  });

  it('the bare apex softy.pro gets the builtin policy too', () => {
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'softy.pro');
    expect(res.meta.builtinHostPatterns).toEqual(['softy.pro']);
    expect(res.meta.callerOverrides).toBe('stricter');
  });

  it('linkedin: no lock → the global default "any", source "default"; new fields at their 0 defaults', () => {
    const res = new SourcesHealthController().crawlPolicy(Site.LINKEDIN);
    expect(res.meta).toMatchObject({
      callerOverrides: 'any',
      callerOverridesProvenance: 'default',
      globalCallerOverrides: 'any',
      builtinHostPatterns: [],
      fleetSize: 1,
    });
    expect(res.minGapMs).toBe(0);
    expect(res.serverErrorCooldownMs).toBe(0);
  });

  it('an explicit global mode is reported as env-global', () => {
    process.env[CRAWL_ENV.CALLER_OVERRIDES] = 'none';
    resetCrawlPolicyEnvCache();
    const res = lockedController().crawlPolicy(Site.SOFTY);
    expect(res.meta).toMatchObject({
      callerOverrides: 'none',
      callerOverridesProvenance: 'env-global',
      globalCallerOverrides: 'none',
    });
  });

  it('an operator sites.softy.callerOverrides "any" replaces the lock (operator-site)', () => {
    process.env[CRAWL_ENV.POLICIES] = JSON.stringify({ sites: { softy: { callerOverrides: 'any' } } });
    resetCrawlPolicyEnvCache();
    const res = lockedController().crawlPolicy(Site.SOFTY, undefined, '{"proxyRotation":"per-request"}');
    expect(res.meta).toMatchObject({ callerOverrides: 'any', callerOverridesProvenance: 'operator-site' });
    expect(res.meta.caller).toEqual({ rejected: [] });
    expect(res.proxyRotation).toBe('per-request');
  });

  it('?crawl= on softy: less polite fields are refused by the lock, more polite ones accepted', () => {
    const res = lockedController().crawlPolicy(
      Site.SOFTY,
      undefined,
      '{"proxyRotation":"per-request","discovery":"listing","minIntervalMs":2000,"callerOverrides":"any"}',
    );
    expect(res.meta.caller!.rejected.sort()).toEqual(['callerOverrides', 'discovery', 'proxyRotation']);
    expect(res.minIntervalMs).toBe(2000);
    expect(res.provenance.minIntervalMs).toBe('caller');
    expect(res.meta.callerOverrides).toBe('stricter');
  });

  it(`meta.fleetSize reports ${CRAWL_EXTRA_ENV.FLEET_SIZE} (the policy values stay per process)`, () => {
    process.env[CRAWL_EXTRA_ENV.FLEET_SIZE] = '3';
    resetCrawlPolicyEnvCache();
    const res = lockedController().crawlPolicy(Site.SOFTY);
    expect(res.meta.fleetSize).toBe(3);
    expect(res.minIntervalMs).toBe(1000);
  });

  it(`${CRAWL_EXTRA_ENV.BUILTIN_HOSTS}=false removes the builtin host lock (liveness-http back to "any")`, () => {
    process.env[CRAWL_EXTRA_ENV.BUILTIN_HOSTS] = 'false';
    resetCrawlPolicyEnvCache();
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(res.meta).toMatchObject({ callerOverrides: 'any', callerOverridesProvenance: 'default', builtinHostPatterns: [] });
    expect(res.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
  });
});

describe('SourcesHealthController.crawlPolicy — disabled builtin hosts and the client floor (Spec 1715)', () => {
  function softyController(declared?: number): SourcesHealthController {
    const registry = new PluginRegistry();
    registry.register(
      {
        site: Site.SOFTY,
        name: 'Softy',
        category: 'ats',
        isAts: true,
        crawl: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000, callerOverrides: 'stricter' },
        ...(declared !== undefined ? { clientMinIntervalFloorMs: declared } : {}),
      },
      scraper,
    );
    return new SourcesHealthController(undefined, registry);
  }

  it(`meta.builtinHostsDisabled is [] by default`, () => {
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(res.meta.builtinHostsDisabled).toEqual([]);
    expect(res.meta.builtinHostPatterns).toEqual(['*.softy.pro']);
  });

  it(`${CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE} lists the patterns switched off; only those stop applying`, () => {
    process.env[CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE] = '*.softy.pro, softy.pro';
    resetCrawlPolicyEnvCache();

    const softy = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(softy.meta).toMatchObject({
      builtinHostsDisabled: ['*.softy.pro', 'softy.pro'],
      builtinHostPatterns: [],
      callerOverrides: 'any',
      callerOverridesProvenance: 'default',
    });
    expect(softy.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);

    // The other builtin entries keep applying (unlike EVER_JOBS_CRAWL_BUILTIN_HOSTS=false).
    const bulk = new SourcesHealthController().crawlPolicy(Site.GREENHOUSE, 'boards-api.greenhouse.io');
    expect(bulk.meta.builtinHostsDisabled).toEqual(['*.softy.pro', 'softy.pro']);
    expect(bulk.meta.builtinHost).toBe('boards-api.greenhouse.io');
    expect(bulk.provenance.maxConcurrentPerHost).toBe('builtin-host');
  });

  it("meta.clientMinIntervalFloorMs reports the plugin's declared client floor", () => {
    const res = softyController(1000).crawlPolicy(Site.SOFTY);
    expect(res.meta.clientMinIntervalFloorMs).toBe(1000);
  });

  it('meta.clientMinIntervalFloorMs is null when the plugin declares none (or no plugin is registered)', () => {
    expect(softyController().crawlPolicy(Site.SOFTY).meta.clientMinIntervalFloorMs).toBeNull();
    expect(softyController(0).crawlPolicy(Site.SOFTY).meta.clientMinIntervalFloorMs).toBeNull();
    expect(new SourcesHealthController().crawlPolicy(Site.LINKEDIN).meta.clientMinIntervalFloorMs).toBeNull();
    expect(new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE).meta.clientMinIntervalFloorMs).toBeNull();
  });

  describe('the EFFECTIVE client floor, from the real Softy plugin metadata (review round 2)', () => {
    /**
     * The API used to read only the declared `clientMinIntervalFloorMs`, so after the
     * documented "undo the lock" / pre-1715 recipe (which needs SOFTY_LEGACY=no-interval-floor)
     * it still said 1000 while the client had no floor. Red control: the round-1
     * controller (declared value only) reports 1000 in the `no-interval-floor` tests.
     */
    const UNLOCK = JSON.stringify({
      sites: { softy: { callerOverrides: 'any' } },
      hosts: { '*.softy.pro': { callerOverrides: 'any' }, 'softy.pro': { callerOverrides: 'any' } },
    });
    function realSoftyController(): SourcesHealthController {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, SoftyService) as IPluginMetadata;
      const registry = new PluginRegistry();
      registry.register(meta, scraper);
      return new SourcesHealthController(undefined, registry);
    }

    it('by default: 1000, and the switch that removes it', () => {
      const res = realSoftyController().crawlPolicy(Site.SOFTY, 'acme.softy.pro');
      expect(res.meta.clientMinIntervalFloorMs).toBe(1000);
      expect(res.meta.clientMinIntervalFloorSwitch).toBe('SOFTY_LEGACY=no-interval-floor');
    });

    it('SOFTY_LEGACY=no-interval-floor + the unlock recipe + a caller minIntervalMs 0: null, and minIntervalMs 0', () => {
      process.env.SOFTY_LEGACY = 'no-interval-floor';
      process.env[CRAWL_ENV.POLICIES] = UNLOCK;
      resetCrawlPolicyEnvCache();

      const res = realSoftyController().crawlPolicy(Site.SOFTY, 'acme.softy.pro', '{"minIntervalMs":0}');

      expect(res.minIntervalMs).toBe(0);
      expect(res.meta.caller).toEqual({ rejected: [] });
      expect(res.meta.clientMinIntervalFloorMs).toBeNull();
    });

    it('SOFTY_LEGACY=all removes it too', () => {
      process.env.SOFTY_LEGACY = 'all';
      expect(realSoftyController().crawlPolicy(Site.SOFTY).meta.clientMinIntervalFloorMs).toBeNull();
    });

    it('effectiveClientMinIntervalFloorMs(): the resolver wins; a throwing one falls back to the declared value', () => {
      expect(effectiveClientMinIntervalFloorMs({ clientMinIntervalFloorMs: 1000, clientMinIntervalFloor: () => 0 })).toBeNull();
      expect(effectiveClientMinIntervalFloorMs({ clientMinIntervalFloorMs: 1000, clientMinIntervalFloor: () => 2500 })).toBe(2500);
      expect(
        effectiveClientMinIntervalFloorMs({
          clientMinIntervalFloorMs: 1000,
          clientMinIntervalFloor: () => {
            throw new Error('config unreadable');
          },
        }),
      ).toBe(1000);
      expect(effectiveClientMinIntervalFloorMs({ clientMinIntervalFloorMs: 1000 })).toBe(1000);
      expect(effectiveClientMinIntervalFloorMs(undefined)).toBeNull();
    });
  });

  it('clientMinIntervalFloorMs() accepts only a finite, positive number', () => {
    expect(clientMinIntervalFloorMs(1000)).toBe(1000);
    expect(clientMinIntervalFloorMs(0.5)).toBe(0.5);
    for (const junk of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      expect(clientMinIntervalFloorMs(junk)).toBeNull();
    }
  });
});

describe('SourcesHealthController.crawlPolicy — process-wide switches and the proxy pin (Spec 1715 review round 2)', () => {
  /**
   * After EVER_JOBS_CRAWL_PRESET=legacy (or an explicit restore value) an operator
   * could not see through any endpoint whether the pin, robots and redirect switches
   * took their pre-1714 value. `meta.switches` shows them; `meta.proxyPin` what the
   * per-host pick of this request keys on (the rule HttpClient applies).
   */
  it('defaults: the new behaviour of every switch', () => {
    const res = new SourcesHealthController().crawlPolicy(Site.LINKEDIN);
    expect(res.meta.switches).toEqual({
      stricterRules: '1714',
      proxyPinScope: 'base',
      robotsBackoff: true,
      paceRedirects: true,
      callerProxyRotation: 'base',
      cooldownBeforeRelease: 'locked',
    });
  });

  it('EVER_JOBS_CRAWL_PRESET=legacy: the pre-1714 value of every switch', () => {
    process.env[CRAWL_ENV.PRESET] = 'legacy';
    resetCrawlPolicyEnvCache();
    expect(new SourcesHealthController().crawlPolicy(Site.LINKEDIN).meta.switches).toEqual({
      stricterRules: '1690',
      proxyPinScope: 'bucket',
      robotsBackoff: false,
      paceRedirects: false,
      callerProxyRotation: 'ranked',
      cooldownBeforeRelease: 'off',
    });
  });

  it('an explicit value wins over the preset default', () => {
    process.env[CRAWL_ENV.PRESET] = 'legacy';
    process.env[CRAWL_EXTRA_ENV.PACE_REDIRECTS] = 'true';
    process.env[CRAWL_EXTRA_ENV.PROXY_PIN_SCOPE] = 'base';
    resetCrawlPolicyEnvCache();
    expect(new SourcesHealthController().crawlPolicy(Site.LINKEDIN).meta.switches).toMatchObject({
      paceRedirects: true,
      proxyPinScope: 'base',
      stricterRules: '1690',
    });
  });

  it('proxyPin: a locked Softy host pins its registrable domain; an unlocked source keeps the pre-1714 bucket pick', () => {
    const softy = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(softy.meta.proxyPin).toEqual({ scope: 'base', keyedOn: 'domain' });
    const linkedin = new SourcesHealthController().crawlPolicy(Site.LINKEDIN, 'www.linkedin.com');
    expect(linkedin.meta.proxyPin).toEqual({ scope: 'bucket', keyedOn: 'host' });
  });

  it('proxyPin: EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket (the pre-1714 pick) shows on a locked host too', () => {
    process.env[CRAWL_EXTRA_ENV.PROXY_PIN_SCOPE] = 'bucket';
    resetCrawlPolicyEnvCache();
    const res = new SourcesHealthController().crawlPolicy(LIVENESS_CRAWL_SITE, 'acme.softy.pro');
    expect(res.meta.proxyPin.scope).toBe('bucket');
    expect(res.meta.switches.proxyPinScope).toBe('bucket');
  });

  it('proxyPin: the builtin Softy lock pins the base domain even when an operator lifted it (Spec 1715 audit C3)', () => {
    process.env[CRAWL_ENV.POLICIES] = JSON.stringify({ hosts: { '*.softy.pro': { callerOverrides: 'any' } } });
    resetCrawlPolicyEnvCache();
    const res = new SourcesHealthController().crawlPolicy('jsonld', 'acme.softy.pro', '{"rateLimitScope":"host"}');
    expect(res.meta.callerOverrides).toBe('any');
    expect(res.rateLimitScope).toBe('host');
    expect(res.meta.proxyPin).toEqual({ scope: 'base', keyedOn: 'domain' });
  });
});

describe('redactCredentials', () => {
  it('hides user:password@ in URLs and bare proxy specs', () => {
    expect(redactCredentials('bad proxy http://user:pa55@proxy:8080 ignored')).toBe(
      'bad proxy http://***@proxy:8080 ignored',
    );
    expect(redactCredentials('"user:pa55@proxy:8080"')).toBe('"***@proxy:8080"');
    expect(redactCredentials('ops@acme.example')).toBe('ops@acme.example');
    expect(redactCredentials('no secrets here')).toBe('no secrets here');
  });

  it('returns @-free text untouched at once, however long', () => {
    const text = '=a:'.repeat(20_000);
    const started = Date.now();
    expect(redactCredentials(text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('stays linear on a long `=x:` run whose `@` is out of reach (no quadratic backtracking)', () => {
    // Unbounded, this took ~1.8 s on a workstation; bounded it takes ~0.1 s.
    const text = '=a:'.repeat(20_000) + ' @';
    const started = Date.now();
    expect(redactCredentials(text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still redacts a password that contains `=`, `(` or `,`', () => {
    expect(redactCredentials('proxy user:abc=d(e,f@proxy:8080 refused')).toBe('proxy ***@proxy:8080 refused');
  });
});
