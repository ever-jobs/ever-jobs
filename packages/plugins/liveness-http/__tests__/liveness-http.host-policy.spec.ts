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
 *
 * The key test answers slowly (700 ms), so the 0.5 s idle gap alone spaces the
 * starts 1.2 s apart and it cannot see the 1 s start-to-start interval. The
 * "fast answers" test does (Spec 1715 review C1): 20 ms answers leave only the
 * interval to hold the starts 1 s apart, and its control lowers ONLY
 * `minIntervalMs` (operator `hosts["*.softy.pro"]`, `minGapMs` kept) to show the
 * starts then drop to answer + gap = 520 ms.
 */
const BUILTIN_HOSTS_FOR_KEY_TEST: string | undefined = undefined;

const LIVENESS_SITE = 'liveness-http';
const PROXIES = ['p1.example:8080', 'p2.example:8080', 'p3.example:8080', 'p4.example:8080'];
/** The fake answers each probe after this long, so the idle gap (not the interval) decides the next start. */
const ANSWER_MS = 700;
/** A fast answer: answer + the 500 ms idle gap stays far below the 1 s interval, so the interval decides. */
const FAST_ANSWER_MS = 20;

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
  let answerMs: number;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    setEnv(Object.fromEntries(CLEARED_ENV.map((name) => [name, undefined])));
    setEnv({ [CRAWL_ENV.PROXIES]: PROXIES.map((p) => `http://${p}`).join(',') });
    probes = [];
    inFlight = 0;
    maxInFlight = 0;
    answerMs = ANSWER_MS;
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
        await new Promise((resolve) => setTimeout(resolve, answerMs));
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
    // ≥ 1 s between starts (with 700 ms answers this follows from the idle gap; the
    // interval on its own is proven by the fast-answers test below) …
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

  describe('fast answers: the 1 s start-to-start interval holds on its own (Spec 1715 review C1)', () => {
    const idleGaps = () => {
      const byStart = [...probes].sort((a, b) => a.startedAt - b.startedAt);
      return byStart.slice(1).map((p, i) => p.startedAt - byStart[i].endedAt!);
    };
    const startGaps = () => {
      const s = starts();
      return s.slice(1).map((t, i) => t - s[i]);
    };

    it('20 ms answers: starts stay ≥ 1 s apart although the idle gap alone would allow 520 ms', async () => {
      answerMs = FAST_ANSWER_MS;

      const { results } = await probeAll();

      expect(results).toEqual(['active', 'active', 'active', 'active']);
      expect(maxInFlight).toBe(1);
      expect(bucketKeys()).toEqual(['domain:softy.pro']);
      // The interval, not the gap, decides: every start is ≥ 1 s after the previous one …
      for (const gap of startGaps()) expect(gap).toBeGreaterThanOrEqual(1000);
      // … and the idle time is far above the 500 ms minGapMs (so the gap is not what held them).
      for (const gap of idleGaps()) expect(gap).toBeGreaterThanOrEqual(1000 - FAST_ANSWER_MS);
    });

    it('control: an operator hosts["*.softy.pro"] {minIntervalMs: 0} (minGapMs kept) → starts only answer + 500 ms apart', async () => {
      answerMs = FAST_ANSWER_MS;
      setEnv({ [CRAWL_ENV.POLICIES]: JSON.stringify({ hosts: { '*.softy.pro': { minIntervalMs: 0 } } }) });

      await probeAll();

      // Still one bucket, one at a time, and the 500 ms idle gap still applies …
      expect(bucketKeys()).toEqual(['domain:softy.pro']);
      expect(maxInFlight).toBe(1);
      for (const gap of idleGaps()) expect(gap).toBeGreaterThanOrEqual(500);
      // … but without the interval the starts fall to answer + gap, below the 975 ms the key test allows.
      expect(startGaps()).toEqual([FAST_ANSWER_MS + 500, FAST_ANSWER_MS + 500, FAST_ANSWER_MS + 500]);
      for (const gap of startGaps()) expect(gap).toBeLessThan(975);
    });
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
