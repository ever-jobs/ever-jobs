import { Logger } from '@nestjs/common';

import { getRequestContext, getRequestId, runWithRequestContext, runWithRequestId } from '../src/context';
import { CRAWL_ENV, POLITE_CRAWL_POLICY } from '../src/http/crawl/defaults';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import * as resolveModule from '../src/http/crawl/resolve';
import {
  CRAWL_POLICY_MEMO_MAX,
  getEffectiveCrawlPolicy,
  getEffectiveProxies,
  getScrapeContext,
  resetEffectiveCrawlPolicyCache,
  runWithScrapeContext,
} from '../src/http/crawl/scrape-context';
import { PluginCrawlPolicy } from '../src/http/crawl/types';

// Count the resolver calls through a module mock that wraps the real function.
// `jest.spyOn(resolveModule, ...)` needs a configurable export property, which
// the CommonJS output of @swc/jest (the default transformer since Spec 1689) does
// not have ("Cannot redefine property"); this works under ts-jest as well.
jest.mock('../src/http/crawl/resolve', () => {
  const actual = jest.requireActual('../src/http/crawl/resolve');
  return { ...actual, explainCrawlPolicy: jest.fn(actual.explainCrawlPolicy) };
});

/** The wrapped `explainCrawlPolicy`, its call log cleared. */
function explainCalls(): jest.Mock {
  const mock = resolveModule.explainCrawlPolicy as unknown as jest.Mock;
  mock.mockClear();
  return mock;
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spec 1690 §4.6 — the per-scrape context carried through AsyncLocalStorage. */
describe('scrape context (Spec 1690)', () => {
  const touched = [
    CRAWL_ENV.POLICIES,
    CRAWL_ENV.RETRIES,
    CRAWL_ENV.PROXIES,
    CRAWL_ENV.LEGACY_PROXIES,
    CRAWL_ENV.CALLER_OVERRIDES,
    CRAWL_ENV.PRESET,
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of touched) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  });
  afterEach(() => {
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  });

  describe('runWithScrapeContext / getScrapeContext', () => {
    it('is undefined outside any context', () => {
      expect(getScrapeContext()).toBeUndefined();
      runWithRequestId('req-1', () => expect(getScrapeContext()).toBeUndefined());
    });

    it('nests inside the request context: the request id survives, and is restored after', () => {
      runWithRequestId('req-1', () => {
        runWithScrapeContext({ site: 'softy' }, () => {
          expect(getRequestId()).toBe('req-1');
          expect(getScrapeContext()).toEqual({ site: 'softy' });
          expect(getRequestContext()).toEqual({ requestId: 'req-1', scrape: { site: 'softy' } });
        });
        expect(getScrapeContext()).toBeUndefined();
        expect(getRequestId()).toBe('req-1');
      });
    });

    it('works outside any request (CLI): no request id', () => {
      runWithScrapeContext({ site: 'softy' }, () => {
        expect(getRequestId()).toBeUndefined();
        expect(getScrapeContext()?.site).toBe('softy');
      });
    });

    it('returns what fn returns, sync and async', async () => {
      expect(runWithScrapeContext({ site: 'a' }, () => 42)).toBe(42);
      await expect(
        runWithScrapeContext({ site: 'a' }, async () => {
          await tick();
          return getScrapeContext()?.site;
        }),
      ).resolves.toBe('a');
    });

    it('the context follows async work started inside it (timers, promises)', async () => {
      const seen = await runWithRequestId('req-2', () =>
        runWithScrapeContext({ site: 'softy' }, async () => {
          await tick(1);
          return new Promise<[string | undefined, string | undefined]>((resolve) =>
            setTimeout(() => resolve([getRequestId(), getScrapeContext()?.site]), 1),
          );
        }),
      );
      expect(seen).toEqual(['req-2', 'softy']);
    });

    it('a nested context inherits omitted fields and replaces set ones (even to undefined)', () => {
      const caller = { retries: 0 };
      const plugin: PluginCrawlPolicy = { maxConcurrentPerHost: 1 };
      runWithScrapeContext({ site: 'outer', caller, plugin, proxies: ['http://p:1'] }, () => {
        runWithScrapeContext({ site: 'inner' }, () => {
          expect(getScrapeContext()).toEqual({ site: 'inner', caller, plugin, proxies: ['http://p:1'] });
        });
        runWithScrapeContext({ plugin: undefined }, () => {
          const ctx = getScrapeContext();
          expect(ctx?.site).toBe('outer');
          expect(ctx?.plugin).toBeUndefined();
        });
        expect(getScrapeContext()?.site).toBe('outer');
      });
    });

    it('an inner signal aborts when the outer one does (deadline still reaches nested work)', () => {
      const outer = new AbortController();
      const inner = new AbortController();
      runWithScrapeContext({ signal: outer.signal }, () => {
        runWithScrapeContext({ signal: inner.signal }, () => {
          const combined = getScrapeContext()?.signal as AbortSignal;
          expect(combined.aborted).toBe(false);
          outer.abort(new Error('deadline'));
          expect(combined.aborted).toBe(true);
          expect((combined.reason as Error).message).toBe('deadline');
        });
      });
    });

    it('aborting the inner signal does not abort the outer scope', () => {
      const outer = new AbortController();
      const inner = new AbortController();
      runWithScrapeContext({ signal: outer.signal }, () => {
        runWithScrapeContext({ signal: inner.signal }, () => {
          inner.abort();
          expect(getScrapeContext()?.signal?.aborted).toBe(true);
        });
        expect(getScrapeContext()?.signal).toBe(outer.signal);
        expect(outer.signal.aborted).toBe(false);
      });
    });

    it('the same signal is not wrapped', () => {
      const outer = new AbortController();
      runWithScrapeContext({ signal: outer.signal }, () => {
        runWithScrapeContext({ site: 'x', signal: outer.signal }, () => {
          expect(getScrapeContext()?.signal).toBe(outer.signal);
        });
      });
    });

    it('concurrent scrapes are isolated from each other', async () => {
      const observe = (site: string, delays: number[]) =>
        runWithRequestId(`req-${site}`, () =>
          runWithScrapeContext({ site }, async () => {
            const seen: string[] = [];
            for (const ms of delays) {
              await tick(ms);
              seen.push(`${getRequestId()}:${getScrapeContext()?.site}`);
            }
            return seen;
          }),
        );
      const [a, b] = await Promise.all([observe('a', [5, 0, 3, 1]), observe('b', [0, 4, 1, 2])]);
      expect(a).toEqual(Array(4).fill('req-a:a'));
      expect(b).toEqual(Array(4).fill('req-b:b'));
      expect(getScrapeContext()).toBeUndefined();
    });

    it('runWithRequestContext merges over the parent context', () => {
      runWithRequestId('req-3', () => {
        runWithRequestContext({ scrape: { site: 's' } }, () => {
          expect(getRequestContext()).toEqual({ requestId: 'req-3', scrape: { site: 's' } });
        });
      });
    });
  });

  describe('getEffectiveCrawlPolicy', () => {
    it('outside any context: preset + env only', () => {
      const policy = getEffectiveCrawlPolicy('acme.example');
      expect(policy.maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
      expect(policy.provenance.maxConcurrentPerHost).toBe('preset');
    });

    it('resolves with the site, plugin and caller of the context in scope', () => {
      process.env[CRAWL_ENV.POLICIES] = JSON.stringify({ sites: { softy: { jitterMs: 250 } } });
      runWithScrapeContext(
        { site: 'softy', plugin: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }, caller: { retries: 0 } },
        () => {
          const policy = getEffectiveCrawlPolicy('acme.softy.pro');
          expect(policy).toMatchObject({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000, jitterMs: 250, retries: 0 });
          expect(policy.provenance).toMatchObject({
            rateLimitScope: 'plugin',
            jitterMs: 'operator-site',
            retries: 'caller',
          });
        },
      );
    });

    it('applies explicit options as the plugin layer and builtin host limits by host', () => {
      runWithScrapeContext({ site: 'greenhouse' }, () => {
        expect(getEffectiveCrawlPolicy('boards-api.greenhouse.io').maxConcurrentPerHost).toBe(16);
        expect(getEffectiveCrawlPolicy('https://boards-api.greenhouse.io/v1/boards/x/jobs').maxConcurrentPerHost).toBe(16);
        expect(getEffectiveCrawlPolicy('boards-api.greenhouse.io', { maxConcurrentPerHost: 2 }).maxConcurrentPerHost).toBe(2);
      });
    });

    it('filters the context caller through EVER_JOBS_CRAWL_CALLER_OVERRIDES', () => {
      process.env[CRAWL_ENV.CALLER_OVERRIDES] = 'none';
      runWithScrapeContext({ site: 'x', caller: { retries: 9 } }, () => {
        expect(getEffectiveCrawlPolicy('x.example').retries).toBe(POLITE_CRAWL_POLICY.retries);
      });
    });

    it('returns a fresh copy each time (memoised underneath), so mutation cannot leak', () => {
      runWithScrapeContext({ site: 'x' }, () => {
        const a = getEffectiveCrawlPolicy('x.example');
        a.retryStatuses.push(999);
        a.provenance.retries = 'caller';
        a.retries = 99;
        const b = getEffectiveCrawlPolicy('x.example');
        expect(b).not.toBe(a);
        expect(b.retries).toBe(POLITE_CRAWL_POLICY.retries);
        expect(b.retryStatuses).toEqual(POLITE_CRAWL_POLICY.retryStatuses);
        expect(b.provenance.retries).toBe('preset');
      });
    });

    it('keys the memo by explicit VALUE (a rebuilt equal object hits; a different one does not)', () => {
      const first = getEffectiveCrawlPolicy('x.example', { retries: 1 });
      expect(getEffectiveCrawlPolicy('x.example', { retries: 1 })).toEqual(first);
      expect(getEffectiveCrawlPolicy('x.example', { retries: 0 }).retries).toBe(0);
    });

    it('logs each resolution note once, at debug level', () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const plugin: PluginCrawlPolicy = { maxConcurrentPerHost: -1 };
        runWithScrapeContext({ site: 'x', plugin }, () => {
          getEffectiveCrawlPolicy('a.example');
          getEffectiveCrawlPolicy('b.example');
          getEffectiveCrawlPolicy('a.example');
        });
        expect(debug).toHaveBeenCalledTimes(1);
        expect(debug.mock.calls[0][0]).toContain('maxConcurrentPerHost');
      } finally {
        debug.mockRestore();
      }
    });

    it('does not mix up two contexts with different callers for the same host', async () => {
      const run = (retries: number) =>
        runWithScrapeContext({ site: 's', caller: { retries } }, async () => {
          await tick(1);
          return getEffectiveCrawlPolicy('s.example').retries;
        });
      await expect(Promise.all([run(0), run(1)])).resolves.toEqual([0, 1]);
    });

    it('keeps a whole search worth of (site, host) entries: LRU, not a wholesale clear at 512', () => {
      const spy = explainCalls();
      try {
        // ~1,850 sites × a host or two, interleaved like a real fan-out.
        const keys = Array.from({ length: 3000 }, (_, i) => [`site${i % 1850}`, `h${i}.example`] as const);
        const pass = () => {
          for (const [site, host] of keys) runWithScrapeContext({ site }, () => getEffectiveCrawlPolicy(host));
        };
        pass();
        const misses = spy.mock.calls.length;
        pass();
        expect(misses).toBe(3000);
        expect(spy.mock.calls.length).toBe(3000); // the second pass is served entirely from the memo
        expect(CRAWL_POLICY_MEMO_MAX).toBeGreaterThanOrEqual(3000);
      } finally {
        spy.mockClear();
      }
    });

    it('evicts the least recently used entry when full', () => {
      const spy = explainCalls();
      try {
        getEffectiveCrawlPolicy('hot.example');
        for (let i = 0; i < CRAWL_POLICY_MEMO_MAX; i++) {
          getEffectiveCrawlPolicy(`cold${i}.example`);
          if (i % 1000 === 0) getEffectiveCrawlPolicy('hot.example'); // keep it recent
        }
        const before = spy.mock.calls.length;
        getEffectiveCrawlPolicy('hot.example');
        expect(spy.mock.calls.length).toBe(before); // still memoised
        getEffectiveCrawlPolicy('cold0.example');
        expect(spy.mock.calls.length).toBe(before + 1); // the oldest went first
      } finally {
        spy.mockClear();
      }
    });

    it('follows the env parse: a new parse (after resetCrawlPolicyEnvCache) is never served from the old memo', () => {
      expect(getEffectiveCrawlPolicy('x.example').retries).toBe(POLITE_CRAWL_POLICY.retries);
      process.env[CRAWL_ENV.RETRIES] = '0';
      expect(getEffectiveCrawlPolicy('x.example').retries).toBe(POLITE_CRAWL_POLICY.retries); // cached parse
      resetCrawlPolicyEnvCache();
      expect(getEffectiveCrawlPolicy('x.example').retries).toBe(0);
    });
  });

  describe('getEffectiveProxies', () => {
    it('explicit > context caller proxies > EVER_JOBS_CRAWL_PROXIES > DEFAULT_PROXIES > none', () => {
      expect(getEffectiveProxies()).toEqual([]);
      process.env[CRAWL_ENV.LEGACY_PROXIES] = 'http://legacy:1';
      resetCrawlPolicyEnvCache();
      expect(getEffectiveProxies()).toEqual(['http://legacy:1']);
      process.env[CRAWL_ENV.PROXIES] = 'http://env:1';
      resetCrawlPolicyEnvCache();
      expect(getEffectiveProxies()).toEqual(['http://env:1']);
      runWithScrapeContext({ proxies: ['http://ctx:1'] }, () => {
        expect(getEffectiveProxies()).toEqual(['http://ctx:1']);
        expect(getEffectiveProxies([])).toEqual(['http://ctx:1']);
        expect(getEffectiveProxies(null)).toEqual(['http://ctx:1']);
        expect(getEffectiveProxies(['http://explicit:1'])).toEqual(['http://explicit:1']);
      });
    });

    it('returns a copy', () => {
      const list = ['http://a:1'];
      const out = getEffectiveProxies(list);
      out.push('x');
      expect(list).toEqual(['http://a:1']);
    });
  });
});
