import 'reflect-metadata';
import type * as dns from 'dns';
import { AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import { Logger } from '@nestjs/common';

import {
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  EGRESS_GUARD_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  EgressBlockedError,
  HostCoolingDownError,
  HostLimiter,
  RobotsDisallowedError,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resetHostLimiter,
  resetRobotsTxtCache,
  runWithScrapeContext,
} from '../../http/crawl';
import type { HttpClient } from '../../http/http-client';
import { BrowserPool } from '../browser-pool';

/**
 * Spec 1690 — `BrowserPool.navigate`: browser navigations under the crawl policy
 * (egress guard, robots.txt, per-host pacing, abort, 429/503 back-off). Pages are
 * fakes with a `goto` (as in plugin specs) or pool pages from a mocked Chromium.
 * No network: DNS is stubbed and robots.txt comes from a fake axios adapter.
 */

const mockLaunch = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
    launchPersistentContext: jest.fn(),
  },
}));

// The real module object: the egress guard looks `dns.lookup` up at call time.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsModule: typeof dns = require('dns');

/** Every crawl env var this suite may read, cleared so the host environment cannot leak in. */
const CLEARED_ENV = [...Object.values(CRAWL_ENV), ...Object.values(CRAWL_EXTRA_ENV), EGRESS_GUARD_ENV.ALLOW_HOSTS];
const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
}

/** A navigation response as Playwright returns it. */
function response(status: number, headers: Record<string, string> = {}): any {
  return { status: () => status, headers: () => headers };
}

/** A fake page (what plugin specs use): `goto` answers with `answer(url)`. */
function fakePage(answer: (url: string) => unknown = () => null): { goto: jest.Mock } {
  return { goto: jest.fn(async (url: string) => answer(url)) };
}

/** A page whose `goto` hangs until `finish()` (or rejects when `fail()` is called). */
function hangingPage(): { page: { goto: jest.Mock }; finish: (value?: unknown) => void; started: () => boolean } {
  let finish: (value?: unknown) => void = () => undefined;
  const page = {
    goto: jest.fn(
      () =>
        new Promise((resolve) => {
          finish = (value?: unknown) => resolve(value ?? null);
        }),
    ),
  };
  return { page, finish: (value?: unknown) => finish(value), started: () => page.goto.mock.calls.length > 0 };
}

const settle = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Stub `dns.lookup` with fixed answers (every address form the guard asks for). */
function stubDns(addresses: Array<{ address: string; family: number }>): jest.SpyInstance {
  return jest.spyOn(dnsModule, 'lookup').mockImplementation(((
    _host: string,
    _opts: unknown,
    cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
  ) => cb(null, addresses)) as unknown as typeof dns.lookup);
}

/** Route the robots.txt client's requests to `answer`; returns the configs it saw. */
function stubRobots(answer: (url: string) => { status: number; data: string }): InternalAxiosRequestConfig[] {
  const seen: InternalAxiosRequestConfig[] = [];
  const client = (BrowserPool as unknown as { robotsHttpClient(): HttpClient }).robotsHttpClient();
  client.getAxiosInstance().defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    seen.push(config);
    const { status, data } = answer(String(config.url));
    return { data, status, statusText: String(status), headers: new AxiosHeaders(), config, request: {} };
  };
  return seen;
}

let limiter: HostLimiter;

beforeEach(() => {
  setEnv(Object.fromEntries(CLEARED_ENV.map((name) => [name, undefined])));
  limiter = new HostLimiter();
  resetHostLimiter(limiter);
  resetRobotsTxtCache();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await BrowserPool.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
  resetRobotsTxtCache();
});

const bucketOf = (key: string) => limiter.snapshot().find((b) => b.key === key);

describe('BrowserPool.navigate (Spec 1690)', () => {
  it('calls page.goto with the URL and the options unchanged, and returns its response', async () => {
    const answer = response(200);
    const page = fakePage(() => answer);

    const result = await BrowserPool.navigate(page as never, 'https://jobs.example.com/a', {
      waitUntil: 'domcontentloaded',
      timeout: 1234,
    });

    expect(result).toBe(answer);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('https://jobs.example.com/a', { waitUntil: 'domcontentloaded', timeout: 1234 });
  });

  describe('pacing', () => {
    it('holds a host-limiter slot for the whole navigation, and releases it when goto settles', async () => {
      const nav = hangingPage();
      const done = BrowserPool.navigate(nav.page as never, 'https://jobs.example.com/a');
      await settle();

      expect(nav.started()).toBe(true);
      expect(bucketOf('host:jobs.example.com')?.active).toBe(1);

      nav.finish();
      await done;
      expect(bucketOf('host:jobs.example.com')?.active).toBe(0);
    });

    it('releases the slot when goto rejects', async () => {
      const page = { goto: jest.fn().mockRejectedValue(new Error('net::ERR_TIMED_OUT')) };

      await expect(BrowserPool.navigate(page as never, 'https://jobs.example.com/a')).rejects.toThrow('ERR_TIMED_OUT');
      expect(bucketOf('host:jobs.example.com')?.active).toBe(0);
    });

    it('a second navigation to the host waits for the slot (maxConcurrentPerHost 1)', async () => {
      setEnv({ [CRAWL_ENV.MAX_CONCURRENT_PER_HOST]: '1', [CRAWL_ENV.MIN_INTERVAL_MS]: '0' });
      const first = hangingPage();
      const second = fakePage();

      const a = BrowserPool.navigate(first.page as never, 'https://jobs.example.com/1');
      await settle();
      const b = BrowserPool.navigate(second as never, 'https://jobs.example.com/2');
      await settle();
      expect(second.goto).not.toHaveBeenCalled();
      expect(bucketOf('host:jobs.example.com')?.queued).toBe(1);

      // Another host is not held up.
      const other = fakePage();
      await BrowserPool.navigate(other as never, 'https://other.example.org/');
      expect(other.goto).toHaveBeenCalledTimes(1);

      first.finish();
      await a;
      await b;
      expect(second.goto).toHaveBeenCalledTimes(1);
    });

    it('spaces navigations by minIntervalMs', async () => {
      setEnv({ [CRAWL_ENV.MIN_INTERVAL_MS]: '150' });
      const starts: number[] = [];
      const page = fakePage(() => {
        starts.push(Date.now());
        return null;
      });

      await Promise.all([1, 2].map((i) => BrowserPool.navigate(page as never, `https://jobs.example.com/${i}`)));

      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(140);
    });

    it('counts against the scrape site and the page crawl options (plugin layer) from getPage', async () => {
      stubDns([{ address: '93.184.216.34', family: 4 }]);
      const page = { goto: jest.fn().mockResolvedValue(null), close: jest.fn().mockResolvedValue(undefined), once: jest.fn() };
      mockLaunch.mockResolvedValue({
        isConnected: () => true,
        newContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(page),
          addInitScript: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined),
        }),
        close: jest.fn().mockResolvedValue(undefined),
      });

      await runWithScrapeContext({ site: 'dice' }, async () => {
        const pooled = await BrowserPool.getPage({ crawl: { rateLimitScope: 'site' } });
        await BrowserPool.navigate(pooled, 'https://www.dice.com/jobs');
      });

      expect(bucketOf('site:dice')).toBeDefined();
      expect(bucketOf('host:www.dice.com')).toBeUndefined();
      expect(page.goto).toHaveBeenCalledTimes(1);
    });
  });

  describe('egress guard', () => {
    it.each([
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.internal/',
      'http://intranet/',
      'file:///etc/passwd',
      'chrome://settings',
      'not a url',
    ])('refuses %s before any goto', async (url) => {
      const page = fakePage();

      await expect(BrowserPool.navigate(page as never, url)).rejects.toBeInstanceOf(EgressBlockedError);
      expect(page.goto).not.toHaveBeenCalled();
      expect(limiter.snapshot()).toEqual([]);
    });

    it('lets local documents (about:, data:) through without a slot', async () => {
      const page = fakePage();

      await BrowserPool.navigate(page as never, 'about:blank');
      await BrowserPool.navigate(page as never, 'data:text/html,<p>hi</p>');

      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(limiter.snapshot()).toEqual([]);
    });

    it('blockPrivateNetworks=false (or an allow-listed host) navigates to a local mock', async () => {
      setEnv({ [EGRESS_GUARD_ENV.ALLOW_HOSTS]: 'mock.test' });
      const page = fakePage();
      await BrowserPool.navigate(page as never, 'http://mock.test:3000/');

      setEnv({ [CRAWL_ENV.BLOCK_PRIVATE_NETWORKS]: 'false' });
      await BrowserPool.navigate(page as never, 'http://127.0.0.1:3000/');

      expect(page.goto.mock.calls.map((c) => c[0])).toEqual(['http://mock.test:3000/', 'http://127.0.0.1:3000/']);
    });

    describe('pages from getPage', () => {
      function poolPage(): { goto: jest.Mock } {
        const page = { goto: jest.fn().mockResolvedValue(null), close: jest.fn().mockResolvedValue(undefined), once: jest.fn() };
        mockLaunch.mockResolvedValue({
          isConnected: () => true,
          newContext: jest.fn().mockResolvedValue({
            newPage: jest.fn().mockResolvedValue(page),
            addInitScript: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
          }),
          close: jest.fn().mockResolvedValue(undefined),
        });
        return page;
      }

      it('resolves the host right before goto and refuses a private answer (DNS pre-check)', async () => {
        const lookup = stubDns([{ address: '10.1.2.3', family: 4 }]);
        const page = poolPage();
        const pooled = await BrowserPool.getPage();

        const err = await BrowserPool.navigate(pooled, 'https://rebound.example.com/').catch((e: Error) => e);

        expect(err).toBeInstanceOf(EgressBlockedError);
        expect((err as Error).message).not.toContain('10.1.2.3');
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(page.goto).not.toHaveBeenCalled();
        expect(bucketOf('host:rebound.example.com')?.active).toBe(0);
      });

      it('a public answer navigates', async () => {
        stubDns([{ address: '93.184.216.34', family: 4 }]);
        const page = poolPage();

        await BrowserPool.navigate(await BrowserPool.getPage(), 'https://jobs.example.com/');

        expect(page.goto).toHaveBeenCalledTimes(1);
      });

      it('a proxied page skips the DNS pre-check (the proxy resolves), but a private caller proxy is refused', async () => {
        const lookup = stubDns([{ address: '10.1.2.3', family: 4 }]);
        const page = poolPage();

        await BrowserPool.navigate(await BrowserPool.getPage({ proxy: 'http://proxy.example.com:3128' }), 'https://jobs.example.com/');
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(lookup).not.toHaveBeenCalled();

        const privateProxy = await BrowserPool.getPage({ proxy: 'http://10.0.0.9:3128' });
        await expect(BrowserPool.navigate(privateProxy, 'https://jobs.example.com/')).rejects.toBeInstanceOf(EgressBlockedError);
        expect(page.goto).toHaveBeenCalledTimes(1);
      });

      it('an operator env proxy is trusted, as in HttpClient', async () => {
        setEnv({ [CRAWL_ENV.PROXIES]: 'http://10.0.0.9:3128' });
        const page = poolPage();

        await BrowserPool.navigate(await BrowserPool.getPage({ proxy: 'http://10.0.0.9:3128' }), 'https://jobs.example.com/');

        expect(page.goto).toHaveBeenCalledTimes(1);
      });
    });

    it('a page getPage did not create (a fake, or a self-launched Chromium) gets the literal check only', async () => {
      const lookup = stubDns([{ address: '10.1.2.3', family: 4 }]);
      const page = fakePage();

      await BrowserPool.navigate(page as never, 'https://jobs.example.com/');

      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('robots.txt', () => {
    const ROBOTS = 'User-agent: *\nDisallow: /private\n';

    it('respect: refuses a disallowed URL before any goto; the file is fetched once, identified and paced', async () => {
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect' });
      const fetched = stubRobots(() => ({ status: 200, data: ROBOTS }));
      const acquire = jest.spyOn(limiter, 'acquire');
      const page = fakePage();

      const err = await BrowserPool.navigate(page as never, 'https://shop.example.com/private/1?token=secret').catch((e: Error) => e);
      await BrowserPool.navigate(page as never, 'https://shop.example.com/jobs');

      expect(err).toBeInstanceOf(RobotsDisallowedError);
      expect((err as Error).message).not.toContain('secret');
      expect(page.goto.mock.calls.map((c) => c[0])).toEqual(['https://shop.example.com/jobs']);
      expect(fetched.map((c) => c.url)).toEqual(['https://shop.example.com/robots.txt']);
      expect((fetched[0].headers as AxiosHeaders).get('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      // robots.txt fetch + the allowed navigation each took a slot of the host's bucket.
      expect(acquire.mock.calls.map((c) => c[0])).toEqual(['host:shop.example.com', 'host:shop.example.com']);
    });

    it('crawl-delay: allowed, and the delay spaces navigations', async () => {
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'crawl-delay', [CRAWL_ENV.MIN_INTERVAL_MS]: '0' });
      stubRobots(() => ({ status: 200, data: 'User-agent: *\nCrawl-delay: 0.3\nDisallow: /private\n' }));
      const acquire = jest.spyOn(limiter, 'acquire');
      const page = fakePage();

      await BrowserPool.navigate(page as never, 'https://shop.example.com/private/1');

      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(acquire.mock.calls[1][1]).toMatchObject({ minIntervalMs: 300 });
    });

    it('off (the default): robots.txt is never fetched', async () => {
      const fetched = stubRobots(() => ({ status: 200, data: 'User-agent: *\nDisallow: /\n' }));
      const page = fakePage();

      await BrowserPool.navigate(page as never, 'https://shop.example.com/private/1');

      expect(fetched).toHaveLength(0);
      expect(page.goto).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort (the scrape deadline)', () => {
    it('an already-aborted scrape navigates nowhere', async () => {
      const controller = new AbortController();
      controller.abort(new Error('deadline'));
      const page = fakePage();

      await expect(
        runWithScrapeContext({ site: 'x', signal: controller.signal }, () => BrowserPool.navigate(page as never, 'https://jobs.example.com/')),
      ).rejects.toThrow('deadline');
      expect(page.goto).not.toHaveBeenCalled();
    });

    it('an abort while queued for a slot leaves the queue without a goto', async () => {
      setEnv({ [CRAWL_ENV.MAX_CONCURRENT_PER_HOST]: '1' });
      const holder = hangingPage();
      const held = BrowserPool.navigate(holder.page as never, 'https://jobs.example.com/1');
      await settle();

      const controller = new AbortController();
      const page = fakePage();
      const queued = runWithScrapeContext({ site: 'x', signal: controller.signal }, () =>
        BrowserPool.navigate(page as never, 'https://jobs.example.com/2'),
      );
      await settle();
      controller.abort(new Error('deadline'));

      await expect(queued).rejects.toThrow('deadline');
      expect(bucketOf('host:jobs.example.com')?.queued).toBe(0);
      holder.finish();
      await held;
      expect(page.goto).not.toHaveBeenCalled();
    });

    it('an abort during the navigation rejects at once and frees the slot', async () => {
      const controller = new AbortController();
      const nav = hangingPage();
      const done = runWithScrapeContext({ site: 'x', signal: controller.signal }, () =>
        BrowserPool.navigate(nav.page as never, 'https://jobs.example.com/'),
      );
      await settle();
      expect(nav.started()).toBe(true);

      controller.abort(new Error('deadline'));

      await expect(done).rejects.toThrow('deadline');
      expect(bucketOf('host:jobs.example.com')?.active).toBe(0);
      nav.finish(); // the page's own goto settling later is harmless
    });
  });

  describe('429 / 503 back-off', () => {
    it('a 429 with a Retry-After over the max cools the bucket for all of it; the next navigation fails fast', async () => {
      const answer = response(429, { 'retry-after': '120' });
      const page = fakePage(() => answer);

      const result = await BrowserPool.navigate(page as never, 'https://jobs.example.com/');

      expect(result).toBe(answer); // the page loaded: the response is still handed back
      const cooling = (bucketOf('host:jobs.example.com')?.coolingDownUntil ?? 0) - Date.now();
      expect(cooling).toBeGreaterThan(119_000);
      expect(cooling).toBeLessThanOrEqual(120_000);
      expect(limiter.slowdownOf('host:jobs.example.com')).toBeGreaterThan(1);

      await expect(BrowserPool.navigate(page as never, 'https://jobs.example.com/next')).rejects.toBeInstanceOf(HostCoolingDownError);
      expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('a 503 without Retry-After backs the bucket off for the throttle floor (5 s)', async () => {
      const recordOutcome = jest.spyOn(limiter, 'recordOutcome');
      const penalize = jest.spyOn(limiter, 'penalize');
      const page = fakePage(() => response(503));

      await BrowserPool.navigate(page as never, 'https://jobs.example.com/');

      expect(recordOutcome).toHaveBeenCalledWith('host:jobs.example.com', 'throttled');
      expect(penalize.mock.calls).toEqual([['host:jobs.example.com', 5000]]);
    });

    it('a 200 is an ok outcome; a null response (same-document navigation) records nothing', async () => {
      const recordOutcome = jest.spyOn(limiter, 'recordOutcome');

      await BrowserPool.navigate(fakePage(() => response(200)) as never, 'https://jobs.example.com/');
      await BrowserPool.navigate(fakePage(() => null) as never, 'https://jobs.example.com/#frag');

      expect(recordOutcome.mock.calls).toEqual([['host:jobs.example.com', 'ok']]);
    });
  });

  describe('EVER_JOBS_CRAWL_BROWSER_NAVIGATION', () => {
    it.each([
      [{ [CRAWL_EXTRA_ENV.BROWSER_NAVIGATION]: 'false' }],
      [{ [CRAWL_ENV.PRESET]: 'legacy' }],
    ])('%j: a plain page.goto — no guard, no slot, as before', async (vars) => {
      setEnv(vars);
      const page = fakePage(() => response(429, { 'retry-after': '600' }));

      await BrowserPool.navigate(page as never, 'http://127.0.0.1:8080/', { timeout: 5 });
      await BrowserPool.navigate(page as never, 'http://127.0.0.1:8080/');

      expect(page.goto.mock.calls).toEqual([
        ['http://127.0.0.1:8080/', { timeout: 5 }],
        ['http://127.0.0.1:8080/', undefined],
      ]);
      expect(limiter.snapshot()).toEqual([]);
    });

    it('legacy with the switch turned back on applies the (unpaced, unguarded) legacy policy', async () => {
      setEnv({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_EXTRA_ENV.BROWSER_NAVIGATION]: 'true' });
      const page = fakePage();

      await BrowserPool.navigate(page as never, 'http://127.0.0.1:8080/');

      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(bucketOf('host:127.0.0.1:8080')).toBeDefined();
    });
  });
});
