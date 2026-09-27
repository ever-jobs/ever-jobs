import 'reflect-metadata';
import axios, { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import {
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  EGRESS_GUARD_ENV,
  fnv1a32,
  getHostLimiter,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resetHostLimiter,
  resetRobotsTxtCache,
  runWithScrapeContext,
} from '@ever-jobs/common';

import { LivenessHttpService } from '../src';

/**
 * Spec 1714 FR-8 / T17 (audit G2, G4, G11, G28) — liveness probes of Softy job
 * URLs run under Softy's host policy, whichever pseudo-site makes them: the
 * builtin `*.softy.pro` entry (`BUILTIN_SOFTY_HOST_POLICY`: one `domain:softy.pro`
 * bucket, 1 in flight, ≥ 1 s between starts, ≥ 0.5 s idle after each answer,
 * `per-host` proxy pin) applies to every request to those hosts. No source
 * change in this plugin: the probes run in the controller's `liveness-http`
 * scrape context and the HttpClient resolves the policy per host.
 *
 * The REAL `HttpClient`, host limiter and proxy pin run; only the transport is a
 * recording fake (`axios.defaults.adapter`), so nothing touches the network.
 *
 * Red control of the key test: set {@link BUILTIN_HOSTS_FOR_KEY_TEST} to
 * `'false'` → two `host:` buckets, overlapping probes, two proxies (test red).
 */
const BUILTIN_HOSTS_FOR_KEY_TEST: string | undefined = undefined;

const LIVENESS_SITE = 'liveness-http';
const PROXIES = ['p1.example:8080', 'p2.example:8080', 'p3.example:8080', 'p4.example:8080'];
/** The fake answers each probe after this long, so the idle gap (not the interval) decides the next start. */
const ANSWER_MS = 700;

const URLS = [
  'https://a.softy.pro/offers/101',
  'https://a.softy.pro/offers/102',
  'https://b.softy.pro/offers/201',
  'https://b.softy.pro/offers/202',
];

const ACTIVE_HTML =
  '<html><head><title>Senior Engineer</title></head><body>' +
  '<p>We are a distributed engineering organisation building data pipelines for the renewable ' +
  'energy sector. The role involves designing resilient ingestion services, reviewing pull ' +
  'requests, mentoring junior colleagues and collaborating with product managers.</p>' +
  '<p>Benefits include flexible hours, a generous learning budget and an annual team offsite.</p>' +
  '<a href="/application">Apply Now</a></body></html>';

interface Probe {
  url: string;
  proxy: string;
  startedAt: number;
  endedAt?: number;
}

const CLEARED_ENV = [
  ...Object.values(CRAWL_ENV),
  ...Object.values(CRAWL_EXTRA_ENV),
  EGRESS_GUARD_ENV.ALLOW_HOSTS,
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCrawlState();
}

function resetCrawlState(): void {
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
  resetRobotsTxtCache();
}

describe('LivenessHttpService — Softy probes run under the builtin host policy (Spec 1714 T17)', () => {
  const originalAdapter = axios.defaults.adapter;
  let probes: Probe[];
  let inFlight: number;
  let maxInFlight: number;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    setEnv(Object.fromEntries(CLEARED_ENV.map((name) => [name, undefined])));
    setEnv({ [CRAWL_ENV.PROXIES]: PROXIES.map((p) => `http://${p}`).join(',') });
    probes = [];
    inFlight = 0;
    maxInFlight = 0;
    // Every HttpClient created from now on inherits this transport (axios.create
    // merges axios.defaults), including the one checkBatch builds.
    axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const probe: Probe = {
        url: String(config.url),
        proxy: (config.httpsAgent as { proxy?: URL } | undefined)?.proxy?.host ?? 'direct',
        startedAt: Date.now(),
      };
      probes.push(probe);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, ANSWER_MS));
        const response = {
          data: ACTIVE_HTML,
          status: 200,
          statusText: 'OK',
          headers: new AxiosHeaders({ 'content-type': 'text/html' }),
          config,
          request: {},
        };
        if (config.validateStatus && !config.validateStatus(200)) {
          throw new AxiosError('unexpected', AxiosError.ERR_BAD_RESPONSE, config, {}, response);
        }
        return response;
      } finally {
        inFlight--;
        probe.endedAt = Date.now();
      }
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    jest.useRealTimers();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    resetCrawlState();
  });

  /** checkBatch in the controller's liveness scrape context; fake time runs until it settles. */
  async function probeAll(): Promise<{ results: string[] }> {
    const service = new LivenessHttpService();
    const done = runWithScrapeContext({ site: LIVENESS_SITE }, () => service.checkBatch(URLS));
    await jest.advanceTimersByTimeAsync(30_000);
    const verdicts = await done;
    return { results: verdicts.map((v) => v.result) };
  }

  const starts = () => probes.map((p) => p.startedAt).sort((a, b) => a - b);
  const bucketKeys = () => getHostLimiter().snapshot().map((b) => b.key).sort();
  const proxyFor = (key: string) => PROXIES[fnv1a32(key) % PROXIES.length];

  it('probes of two tenants share one bucket and one proxy, one at a time, ≥ 1 s apart and ≥ 0.5 s idle (key test)', async () => {
    setEnv({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: BUILTIN_HOSTS_FOR_KEY_TEST });

    const { results } = await probeAll();

    expect(results).toEqual(['active', 'active', 'active', 'active']);
    expect(probes).toHaveLength(4);
    // Never 2 in flight to the shared Softy server, although the batch runs 4 workers.
    expect(maxInFlight).toBe(1);
    // ≥ 1 s between starts (minIntervalMs) …
    const s = starts();
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeGreaterThanOrEqual(975);
    // … and ≥ 0.5 s idle after each answer (minGapMs): with 700 ms answers the gap decides.
    const byStart = [...probes].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < byStart.length; i++) {
      expect(byStart[i].startedAt - byStart[i - 1].endedAt!).toBeGreaterThanOrEqual(475);
    }
    expect(s[1] - s[0]).toBe(ANSWER_MS + 500);
    // One bucket for the whole registrable domain, one proxy for every probe.
    expect(bucketKeys()).toEqual(['domain:softy.pro']);
    expect(new Set(probes.map((p) => p.proxy))).toEqual(new Set([proxyFor('domain:softy.pro')]));
  });

  it('EVER_JOBS_CRAWL_BUILTIN_HOSTS=false (no host policy): two host buckets, overlapping probes, two proxies', async () => {
    setEnv({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'false' });

    await probeAll();

    expect(bucketKeys()).toEqual(['host:a.softy.pro', 'host:b.softy.pro']);
    expect(maxInFlight).toBeGreaterThan(1);
    const perTenant = (tenant: string) => new Set(probes.filter((p) => p.url.includes(`//${tenant}.`)).map((p) => p.proxy));
    expect(perTenant('a')).toEqual(new Set([proxyFor('host:a.softy.pro')]));
    expect(perTenant('b')).toEqual(new Set([proxyFor('host:b.softy.pro')]));
    expect(proxyFor('host:a.softy.pro')).not.toBe(proxyFor('host:b.softy.pro'));
  });

  it('an operator hosts["*.softy.pro"] entry still wins over the builtin one (flexibility)', async () => {
    setEnv({
      [CRAWL_ENV.POLICIES]: JSON.stringify({
        hosts: { '*.softy.pro': { rateLimitScope: 'host', maxConcurrentPerHost: 4, minIntervalMs: 100, minGapMs: 0 } },
      }),
    });

    await probeAll();

    expect(bucketKeys()).toEqual(['host:a.softy.pro', 'host:b.softy.pro']);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('other hosts keep the generic defaults (no Softy pacing leaks out)', async () => {
    const service = new LivenessHttpService();
    const done = runWithScrapeContext({ site: LIVENESS_SITE }, () =>
      service.checkBatch(['https://jobs.example.com/1', 'https://jobs.example.com/2']),
    );
    await jest.advanceTimersByTimeAsync(30_000);
    await done;

    expect(bucketKeys()).toEqual(['host:jobs.example.com']);
    expect(maxInFlight).toBe(2);
  });
});
