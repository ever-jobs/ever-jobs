import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IScraper, JobResponseDto, Site } from '@ever-jobs/models';
import {
  CRAWL_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  POLITE_CRAWL_POLICY,
  resetCrawlPolicyEnvCache,
} from '@ever-jobs/common';
import { PluginRegistry } from '@ever-jobs/plugin';
import { LIVENESS_CRAWL_SITE } from '../crawl-policy.mapping';
import { SourcesHealthController, redactCredentials } from '../health.controller';

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

const ENV_KEYS = [CRAWL_ENV.CALLER_OVERRIDES, CRAWL_ENV.POLICIES, CRAWL_ENV.PRESET, CRAWL_ENV.PROXIES];
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
