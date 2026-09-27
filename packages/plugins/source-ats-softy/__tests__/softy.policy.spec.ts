import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * Softy discovery against the REAL crawl-policy resolver (Spec 1690 layers, Spec
 * 1714 lock), with only the HTTP client faked: proves each configuration surface —
 * caller `crawl`, `EVER_JOBS_CRAWL_DISCOVERY`, operator `sites.softy` /
 * `hosts["*.softy.pro"]`, and a surrounding scrape context — actually selects the
 * discovery mode, and that the Softy site-owner lock (`callerOverrides: 'stricter'`)
 * refuses a caller's `listing` on every path (Spec 1715 FR-3).
 */

const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args) };
});

import {
  BUILTIN_HOST_POLICIES,
  BUILTIN_SOFTY_HOST_POLICY,
  explainCrawlPolicy,
  getScrapeContext,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resolveCrawlPolicy,
  runWithScrapeContext,
} from '@ever-jobs/common';
import { SoftyService } from '../src/softy.service';
import { SOFTY_CRAWL_POLICY } from '../src/softy.constants';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = 'https://acme.softy.pro';
const SITEMAP = `${BASE}/sitemap.xml`;
const PAGE1 = `${BASE}/offers?page=1`;

const ENV_KEYS = [
  'EVER_JOBS_CRAWL_DISCOVERY',
  'EVER_JOBS_CRAWL_POLICIES',
  'EVER_JOBS_CRAWL_CALLER_OVERRIDES',
  'EVER_JOBS_CRAWL_PRESET',
  'EVER_JOBS_CRAWL_PLUGIN_MANIFESTS',
  'EVER_JOBS_CRAWL_BUILTIN_HOSTS',
  'SOFTY_LEGACY',
];

/** Operator policy that lifts the Softy lock (the documented escape hatch, Spec 1714 §7.4). */
const LIFT_LOCK = JSON.stringify({ sites: { softy: { callerOverrides: 'any' } } });

describe('SoftyService discovery through the real crawl policy (Specs 1690, 1691, 1714, 1715)', () => {
  const saved: Record<string, string | undefined> = {};
  let calls: string[];
  let contextsSeen: unknown[];

  function setEnv(key: string, value: string): void {
    process.env[key] = value;
    resetCrawlPolicyEnvCache();
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    calls = [];
    contextsSeen = [];
    const routes: Record<string, string> = {
      [SITEMAP]: fixture('sitemap.xml'),
      [PAGE1]: fixture('listing-page-1.html'),
    };
    mockCreateHttpClient.mockReset().mockImplementation(() => ({
      setHeaders: jest.fn(),
      post: jest.fn(),
      get: jest.fn(async (url: string, config?: any) => {
        calls.push(url);
        contextsSeen.push(getScrapeContext());
        const body = routes[url];
        if (body === undefined) {
          throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
        }
        return { data: config?.responseType === 'arraybuffer' ? Buffer.from(body) : body, status: 200 };
      }),
    }));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  });

  const scrape = (extra: Record<string, unknown> = {}) =>
    new SoftyService().scrape(
      new ScraperInputDto({
        siteType: [Site.SOFTY],
        companySlug: 'acme',
        resultsWanted: 1,
        descriptionFormat: DescriptionFormat.PLAIN,
        ...extra,
      } as Partial<ScraperInputDto>),
    );

  it('defaults to auto → sitemap first', async () => {
    await scrape();
    expect(calls[0]).toBe(SITEMAP);
  });

  // ── the site-owner lock on discovery (Spec 1714 FR-1, Spec 1715 FR-3) ────────

  it("refuses a caller's crawl.discovery 'listing' (the Softy lock): sitemap first", async () => {
    await scrape({ crawl: { discovery: 'listing' } });
    expect(calls[0]).toBe(SITEMAP);
  });

  it("an operator sites.softy.callerOverrides 'any' lifts the lock: the caller's listing wins", async () => {
    setEnv('EVER_JOBS_CRAWL_POLICIES', LIFT_LOCK);
    await scrape({ crawl: { discovery: 'listing' } });
    expect(calls[0]).toBe(PAGE1);
  });

  it("accepts a caller's 'sitemap' over an operator 'listing' (sitemap is at least as polite)", async () => {
    setEnv('EVER_JOBS_CRAWL_POLICIES', JSON.stringify({ sites: { softy: { discovery: 'listing' } } }));
    await scrape({ crawl: { discovery: 'sitemap' } });
    expect(calls[0]).toBe(SITEMAP);
  });

  it("inside JobsService's scrape context the lock applies too, and the context is not replaced", async () => {
    const ctx = { site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' as const } };
    await runWithScrapeContext(ctx, () => scrape({ crawl: { discovery: 'sitemap' } }));
    expect(calls[0]).toBe(SITEMAP);
    expect(contextsSeen[0]).toMatchObject(ctx);
  });

  it("inside a scrape context, with the lock lifted by the operator, the context's caller listing decides", async () => {
    setEnv('EVER_JOBS_CRAWL_POLICIES', LIFT_LOCK);
    const ctx = { site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' as const } };
    await runWithScrapeContext(ctx, () => scrape({ crawl: { discovery: 'sitemap' } }));
    expect(calls[0]).toBe(PAGE1);
  });

  // ── operator surfaces (unchanged) ────────────────────────────────────────────

  it('honours EVER_JOBS_CRAWL_DISCOVERY', async () => {
    setEnv('EVER_JOBS_CRAWL_DISCOVERY', 'listing');
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it('honours an operator sites.softy policy', async () => {
    setEnv('EVER_JOBS_CRAWL_POLICIES', JSON.stringify({ sites: { softy: { discovery: 'listing' } } }));
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it('honours an operator hosts["*.softy.pro"] policy', async () => {
    setEnv('EVER_JOBS_CRAWL_POLICIES', JSON.stringify({ hosts: { '*.softy.pro': { discovery: 'listing' } } }));
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it("an operator's EVER_JOBS_CRAWL_DISCOVERY=sitemap beats descriptionDepth 'board' (FR-11)", async () => {
    setEnv('EVER_JOBS_CRAWL_DISCOVERY', 'sitemap');
    const res = await scrape({ descriptionDepth: 'board' });
    expect(calls).toEqual([SITEMAP]);
    expect(res.diagnostics?.reason).toBe('partial');
  });

  it("SOFTY_LEGACY=board-over-sitemap: board beats the operator's sitemap (pre-1715)", async () => {
    setEnv('EVER_JOBS_CRAWL_DISCOVERY', 'sitemap');
    process.env.SOFTY_LEGACY = 'board-over-sitemap';
    await scrape({ descriptionDepth: 'board' });
    expect(calls).toEqual([PAGE1]);
  });

  it('runs its requests inside a scrape context carrying the plugin policy when called directly', async () => {
    await scrape({ crawl: { discovery: 'listing' } });
    expect(contextsSeen[0]).toMatchObject({ site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' } });
  });

  // ── the resolved policy (Spec 1715 FR-1) ─────────────────────────────────────

  const FR1 = {
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
    userAgentMode: 'identify',
  };

  it('resolves softy on acme.softy.pro to the FR-1 numbers, locked to stricter', () => {
    const explained = explainCrawlPolicy({ site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_CRAWL_POLICY });
    expect(explained.policy).toMatchObject(FR1);
    expect(explained.callerOverrides).toBe('stricter');
    expect(resolveCrawlPolicy({ site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_CRAWL_POLICY })).toMatchObject(FR1);
  });

  it('a default-install caller cannot loosen any of it (G0, G3, G9, G12)', () => {
    const caller = {
      minIntervalMs: 0,
      minGapMs: 0,
      maxConcurrentPerHost: 0,
      rateLimitScope: 'host' as const,
      proxyRotation: 'per-request' as const,
      userAgentMode: 'plugin' as const,
      respectRetryAfter: false,
      retries: 10,
      throttleRetryDelayMs: 0,
      serverErrorCooldownMs: 0,
      retryAfterOverMax: 'cap' as const,
      discovery: 'listing' as const,
    };
    const explained = explainCrawlPolicy({ site: 'softy', host: 'acme.softy.pro', plugin: SOFTY_CRAWL_POLICY, caller });
    expect(explained.policy).toMatchObject(FR1);
    expect(explained.policy.discovery).toBe('auto');
    expect([...explained.callerRejected].sort()).toEqual(Object.keys(caller).sort());
  });

  // ── parity with the builtin *.softy.pro host policy (Spec 1714 FR-8) ─────────

  describe('parity: SOFTY_CRAWL_POLICY vs BUILTIN_SOFTY_HOST_POLICY', () => {
    it('the builtin host table maps *.softy.pro and softy.pro to BUILTIN_SOFTY_HOST_POLICY', () => {
      expect(BUILTIN_HOST_POLICIES['*.softy.pro']).toBe(BUILTIN_SOFTY_HOST_POLICY);
      expect(BUILTIN_HOST_POLICIES['softy.pro']).toBe(BUILTIN_SOFTY_HOST_POLICY);
    });

    it('every field of the builtin host policy equals the manifest’s', () => {
      for (const [field, value] of Object.entries(BUILTIN_SOFTY_HOST_POLICY)) {
        expect({ field, value: (SOFTY_CRAWL_POLICY as Record<string, unknown>)[field] }).toEqual({ field, value });
      }
    });

    it('the manifest has no other field than those plus userAgentMode', () => {
      const extra = Object.keys(SOFTY_CRAWL_POLICY).filter((field) => !(field in BUILTIN_SOFTY_HOST_POLICY));
      expect(extra).toEqual(['userAgentMode']);
    });

    it('a request to a Softy host from ANOTHER plugin resolves to the same pace and lock', () => {
      const viaHost = explainCrawlPolicy({ site: 'liveness-http', host: 'acme.softy.pro' });
      const { userAgentMode: _ua, ...pace } = FR1;
      expect(viaHost.policy).toMatchObject(pace);
      expect(viaHost.callerOverrides).toBe('stricter');
    });
  });
});
