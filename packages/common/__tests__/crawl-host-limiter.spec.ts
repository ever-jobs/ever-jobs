import { Logger } from '@nestjs/common';

import { CrawlQueueTimeoutError, HostCoolingDownError } from '../src/http/crawl/errors';
import {
  HOST_LIMITER_ENV,
  HostLimiter,
  bucketKeyFor,
  getHostLimiter,
  hostLimiterOptionsFromEnv,
  resetHostLimiter,
} from '../src/http/crawl/host-limiter';
import { HostLimiterAcquireOptions } from '../src/http/crawl/types';

const T0 = 1_700_000_000_000;

function opts(overrides: Partial<HostLimiterAcquireOptions> = {}): HostLimiterAcquireOptions {
  return { maxConcurrent: 0, minIntervalMs: 0, jitterMs: 0, maxWaitMs: 0, adaptive: false, ...overrides };
}

/** Let resolved promises run their `.then` callbacks without moving the clock. */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

/** Record when each acquire was granted (relative to T0); optionally release at once. */
function track(limiter: HostLimiter, key: string, o: HostLimiterAcquireOptions, n: number, releaseImmediately = true) {
  const starts: number[] = [];
  const order: number[] = [];
  const releases: Array<() => void> = [];
  const errors: unknown[] = [];
  for (let i = 0; i < n; i++) {
    limiter.acquire(key, o).then(
      (release) => {
        starts.push(Date.now() - T0);
        order.push(i);
        if (releaseImmediately) release();
        else releases.push(release);
      },
      (err) => errors.push(err),
    );
  }
  return { starts, order, releases, errors };
}

describe('HostLimiter — Spec 1690 §4.3', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetHostLimiter();
  });

  describe('spacing', () => {
    it('a 100-wide burst with maxConcurrent 1 and a 1000 ms interval starts exactly one request per second', async () => {
      const limiter = new HostLimiter();
      const { starts, order } = track(limiter, 'host:acme.softy.pro', opts({ maxConcurrent: 1, minIntervalMs: 1000 }), 100);

      await flush();
      expect(starts).toEqual([0]);

      for (let second = 1; second < 100; second++) {
        await jest.advanceTimersByTimeAsync(999);
        expect(starts).toHaveLength(second); // nothing early
        await jest.advanceTimersByTimeAsync(1);
        expect(starts).toHaveLength(second + 1);
        expect(starts[second]).toBe(second * 1000);
      }
      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i)); // FIFO
      expect(limiter.snapshot()).toEqual([{ key: 'host:acme.softy.pro', active: 0, queued: 0, slowdown: 1 }]);
    });

    it('spaces starts even with unlimited concurrency (fixes the old one-gap-then-burst rateDelay)', async () => {
      const limiter = new HostLimiter();
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 0, minIntervalMs: 250 }), 5, false);
      await jest.advanceTimersByTimeAsync(2000);
      expect(starts).toEqual([0, 250, 500, 750, 1000]);
    });

    it('adds jitter in [0, jitterMs] from the injected random source', async () => {
      const randoms = [0, 0.5, 0.999999];
      const limiter = new HostLimiter({ random: () => randoms.shift() ?? 0 });
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 1, minIntervalMs: 100, jitterMs: 50 }), 4);
      await jest.advanceTimersByTimeAsync(10_000);
      // gaps: 100+0, 100+25, 100+50
      expect(starts).toEqual([0, 100, 225, 375]);
    });

    it('never produces a gap outside [minInterval, minInterval + jitter] with Math.random', async () => {
      const limiter = new HostLimiter();
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 1, minIntervalMs: 100, jitterMs: 40 }), 50);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(starts).toHaveLength(50);
      for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        expect(gap).toBeGreaterThanOrEqual(100);
        expect(gap).toBeLessThanOrEqual(140);
      }
    });

    it('keeps buckets independent', async () => {
      const limiter = new HostLimiter();
      const a = track(limiter, 'host:a.example', opts({ maxConcurrent: 1, minIntervalMs: 1000 }), 2);
      const b = track(limiter, 'host:b.example', opts({ maxConcurrent: 1, minIntervalMs: 1000 }), 2);
      await flush();
      expect(a.starts).toEqual([0]);
      expect(b.starts).toEqual([0]);
      await jest.advanceTimersByTimeAsync(1000);
      expect(a.starts).toEqual([0, 1000]);
      expect(b.starts).toEqual([0, 1000]);
    });
  });

  describe('concurrency', () => {
    it('maxConcurrent 4 never has more than 4 in flight and serves everyone', async () => {
      const limiter = new HostLimiter();
      let active = 0;
      let peak = 0;
      let done = 0;
      const durations = [30, 10, 50, 20, 40];
      for (let i = 0; i < 60; i++) {
        void limiter.acquire('k', opts({ maxConcurrent: 4 })).then((release) => {
          active++;
          peak = Math.max(peak, active);
          expect(limiter.snapshot()[0].active).toBeLessThanOrEqual(4);
          setTimeout(() => {
            active--;
            done++;
            release();
          }, durations[i % durations.length]);
        });
      }
      await jest.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(60);
      expect(peak).toBe(4);
    });

    it('maxConcurrent 0 is unlimited', async () => {
      const limiter = new HostLimiter();
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 0 }), 25, false);
      await flush();
      expect(starts).toHaveLength(25);
    });

    it('release is idempotent: a double release does not let an extra request in', async () => {
      const limiter = new HostLimiter();
      const { starts, releases } = track(limiter, 'k', opts({ maxConcurrent: 1 }), 3, false);
      await flush();
      expect(starts).toHaveLength(1);
      releases[0]();
      releases[0]();
      await flush();
      expect(starts).toHaveLength(2);
      expect(limiter.snapshot()[0]).toMatchObject({ active: 1, queued: 1 });
      releases[1]();
      releases[1]();
      await flush();
      expect(starts).toHaveLength(3);
      releases[2]();
      releases[2]();
      expect(limiter.snapshot()[0]).toMatchObject({ active: 0, queued: 0 });
    });
  });

  describe('cool-down', () => {
    it('penalize holds every request of the bucket until the cool-down ends', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 5000);
      expect(limiter.coolingDownUntil('k')).toBe(T0 + 5000);
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 0 }), 3);
      await jest.advanceTimersByTimeAsync(4999);
      expect(starts).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([5000, 5000, 5000]);
      expect(limiter.coolingDownUntil('k')).toBe(0);
    });

    it('penalize while requests are queued pushes the pending timer back', async () => {
      const limiter = new HostLimiter();
      const { starts } = track(limiter, 'k', opts({ maxConcurrent: 1, minIntervalMs: 1000 }), 2);
      await flush();
      expect(starts).toEqual([0]);
      limiter.penalize('k', 3000);
      await jest.advanceTimersByTimeAsync(2999);
      expect(starts).toEqual([0]);
      await jest.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 3000]);
    });

    it('never shortens an existing cool-down, and ignores non-positive values', () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 5000);
      limiter.penalize('k', 1000);
      limiter.penalize('k', 0);
      limiter.penalize('k', -1);
      limiter.penalize('k', Number.NaN);
      expect(limiter.coolingDownUntil('k')).toBe(T0 + 5000);
      expect(limiter.coolingDownUntil('unknown')).toBe(0);
    });

    it('fails fast with HostCoolingDownError when the cool-down exceeds maxWaitMs', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 10_000);
      const err = await limiter.acquire('k', opts({ maxWaitMs: 1000 })).catch((e) => e);
      expect(err).toBeInstanceOf(HostCoolingDownError);
      expect(err).toMatchObject({ code: 'ERR_CRAWL_HOST_COOLING_DOWN', bucket: 'k', retryAfterMs: 10_000 });
      expect(limiter.snapshot()[0].queued).toBe(0);
    });

    it('waits out a cool-down shorter than maxWaitMs', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 500);
      const { starts, errors } = track(limiter, 'k', opts({ maxWaitMs: 1000 }), 1);
      await jest.advanceTimersByTimeAsync(600);
      expect(errors).toEqual([]);
      expect(starts).toEqual([500]);
    });
  });

  describe('adaptive throttle', () => {
    it('throttled doubles the slowdown up to 16; ok decays it by 0.8 down to 1; error is neutral', () => {
      const limiter = new HostLimiter();
      limiter.recordOutcome('k', 'throttled');
      expect(limiter.slowdownOf('k')).toBe(2);
      for (let i = 0; i < 10; i++) limiter.recordOutcome('k', 'throttled');
      expect(limiter.slowdownOf('k')).toBe(16);
      limiter.recordOutcome('k', 'error');
      expect(limiter.slowdownOf('k')).toBe(16);
      limiter.recordOutcome('k', 'ok');
      expect(limiter.slowdownOf('k')).toBeCloseTo(12.8);
      for (let i = 0; i < 50; i++) limiter.recordOutcome('k', 'ok');
      expect(limiter.slowdownOf('k')).toBe(1);
      expect(limiter.slowdownOf('never-seen')).toBe(1);
    });

    it('applies a 500 ms × slowdown floor when the interval is 0 (adaptive requests only)', async () => {
      const limiter = new HostLimiter();
      limiter.recordOutcome('k', 'throttled'); // slowdown 2 → 1000 ms gap
      const polite = track(limiter, 'k', opts({ maxConcurrent: 0, minIntervalMs: 0, adaptive: true }), 3);
      await jest.advanceTimersByTimeAsync(0);
      expect(polite.starts).toEqual([0]);
      await jest.advanceTimersByTimeAsync(2000);
      expect(polite.starts).toEqual([0, 1000, 2000]);
    });

    it('does not slow a request that did not ask for adaptive throttling', async () => {
      const limiter = new HostLimiter();
      limiter.recordOutcome('k', 'throttled');
      const legacy = track(limiter, 'k', opts({ maxConcurrent: 0, minIntervalMs: 0, adaptive: false }), 3);
      await flush();
      expect(legacy.starts).toEqual([0, 0, 0]);
    });

    it('multiplies a non-zero interval by the slowdown, and recovers as outcomes turn ok', async () => {
      const limiter = new HostLimiter();
      limiter.recordOutcome('k', 'throttled');
      limiter.recordOutcome('k', 'throttled'); // 4
      const o = opts({ maxConcurrent: 1, minIntervalMs: 100, adaptive: true });
      const first = track(limiter, 'k', o, 2);
      await jest.advanceTimersByTimeAsync(1000);
      expect(first.starts).toEqual([0, 400]);

      for (let i = 0; i < 20; i++) limiter.recordOutcome('k', 'ok');
      const base = Date.now() - T0;
      const later = track(limiter, 'k', o, 2);
      await jest.advanceTimersByTimeAsync(1000);
      expect(later.starts.map((s) => s - base)).toEqual([0, 100]);
    });

    it('honours custom adaptive tunables', () => {
      const limiter = new HostLimiter({ maxSlowdown: 3, slowdownFactor: 1.5, recoveryFactor: 0.5 });
      for (let i = 0; i < 5; i++) limiter.recordOutcome('k', 'throttled');
      expect(limiter.slowdownOf('k')).toBe(3);
      limiter.recordOutcome('k', 'ok');
      expect(limiter.slowdownOf('k')).toBe(1.5);
    });
  });

  describe('abort and timeout', () => {
    it('an aborted waiter leaves the queue and rejects with the signal reason', async () => {
      const limiter = new HostLimiter();
      const holder = track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      await flush();
      const controller = new AbortController();
      const reason = new Error('search deadline');
      const pending = limiter.acquire('k', opts({ maxConcurrent: 1, signal: controller.signal })).catch((e) => e);
      const after = track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      expect(limiter.snapshot()[0].queued).toBe(2);

      controller.abort(reason);
      expect(await pending).toBe(reason);
      expect(limiter.snapshot()[0].queued).toBe(1);

      holder.releases[0]();
      await flush();
      expect(after.starts).toHaveLength(1); // the one behind the aborted waiter got the slot
    });

    it('aborting without a reason rejects with an AbortError', async () => {
      const limiter = new HostLimiter();
      track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      await flush();
      const controller = new AbortController();
      const pending = limiter.acquire('k', opts({ maxConcurrent: 1, signal: controller.signal })).catch((e) => e);
      controller.abort();
      expect((await pending).name).toBe('AbortError');
    });

    it('rejects at once when the signal is already aborted, without queueing', async () => {
      const limiter = new HostLimiter();
      const controller = new AbortController();
      controller.abort(new Error('gone'));
      await expect(limiter.acquire('k', opts({ signal: controller.signal }))).rejects.toThrow('gone');
      expect(limiter.size).toBe(0);
    });

    it('an abort after the grant is ignored (the caller cancels its own request)', async () => {
      const limiter = new HostLimiter();
      const controller = new AbortController();
      const release = await limiter.acquire('k', opts({ maxConcurrent: 1, signal: controller.signal }));
      controller.abort();
      expect(limiter.snapshot()[0].active).toBe(1);
      release();
      expect(limiter.snapshot()[0].active).toBe(0);
    });

    it('rejects with CrawlQueueTimeoutError after maxWaitMs and keeps FIFO for the rest', async () => {
      const limiter = new HostLimiter();
      const holder = track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      await flush();
      const timed = limiter.acquire('k', opts({ maxConcurrent: 1, maxWaitMs: 500 })).catch((e) => e);
      const patient = track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);

      await jest.advanceTimersByTimeAsync(499);
      expect(limiter.snapshot()[0].queued).toBe(2);
      await jest.advanceTimersByTimeAsync(1);
      const err = await timed;
      expect(err).toBeInstanceOf(CrawlQueueTimeoutError);
      expect(err).toMatchObject({ code: 'ERR_CRAWL_QUEUE_TIMEOUT', bucket: 'k', waitedMs: 500 });
      expect(limiter.snapshot()[0].queued).toBe(1);

      holder.releases[0]();
      await flush();
      expect(patient.starts).toHaveLength(1);
    });

    it('maxWaitMs 0 waits indefinitely', async () => {
      const limiter = new HostLimiter();
      track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      const waiting = track(limiter, 'k', opts({ maxConcurrent: 1, maxWaitMs: 0 }), 1);
      await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(waiting.errors).toEqual([]);
      expect(limiter.snapshot()[0].queued).toBe(1);
    });
  });

  describe('LRU bound', () => {
    async function useOnce(limiter: HostLimiter, key: string): Promise<void> {
      const release = await limiter.acquire(key, opts());
      release();
    }

    it('evicts the least recently used idle bucket beyond maxBuckets', async () => {
      const limiter = new HostLimiter({ maxBuckets: 3 });
      await useOnce(limiter, 'a');
      await useOnce(limiter, 'b');
      await useOnce(limiter, 'c');
      await useOnce(limiter, 'a'); // a is now the most recent
      await useOnce(limiter, 'd');
      expect(limiter.snapshot().map((b) => b.key)).toEqual(['c', 'a', 'd']);
    });

    it('never evicts a bucket with active or queued work, or one still cooling down', async () => {
      const limiter = new HostLimiter({ maxBuckets: 2 });
      const busy = track(limiter, 'busy', opts({ maxConcurrent: 1 }), 2, false); // 1 active + 1 queued
      await flush();
      limiter.penalize('cooling', 60_000);
      await useOnce(limiter, 'x');
      await useOnce(limiter, 'y');
      const keys = limiter.snapshot().map((b) => b.key);
      expect(keys).toEqual(expect.arrayContaining(['busy', 'cooling', 'y']));
      expect(keys).not.toContain('x');
      expect(limiter.snapshot().find((b) => b.key === 'busy')).toMatchObject({ active: 1, queued: 1 });

      busy.releases[0]();
      await flush();
      expect(busy.starts).toHaveLength(2);
    });

    it('does not evict a bucket that is still inside its spacing window', async () => {
      const limiter = new HostLimiter({ maxBuckets: 1 });
      const release = await limiter.acquire('spaced', opts({ minIntervalMs: 1000 }));
      release();
      await useOnce(limiter, 'other');
      expect(limiter.snapshot().map((b) => b.key)).toContain('spaced');
      await jest.advanceTimersByTimeAsync(1000);
      await useOnce(limiter, 'third');
      expect(limiter.snapshot().map((b) => b.key)).not.toContain('spaced');
    });

    it('defaults to 10,000 buckets', async () => {
      const limiter = new HostLimiter();
      for (let i = 0; i < 10_050; i++) await useOnce(limiter, `k${i}`);
      expect(limiter.size).toBe(10_000);
    });
  });

  describe('timers', () => {
    it('keeps its timers ref\'d while a request waits (a paced request must keep the process alive)', async () => {
      jest.useRealTimers();
      const armed: NodeJS.Timeout[] = [];
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const t = realSetTimeout(fn, ms);
        armed.push(t);
        return t;
      }) as typeof setTimeout);

      const limiter = new HostLimiter();
      const release = await limiter.acquire('k', opts({ maxConcurrent: 1, minIntervalMs: 60_000 }));
      const controller = new AbortController();
      const queued = limiter.acquire('k', opts({ maxConcurrent: 1, minIntervalMs: 60_000, maxWaitMs: 30_000, signal: controller.signal }));
      release(); // pump → spacing timer
      expect(armed.length).toBeGreaterThanOrEqual(2); // max-wait timer + pump timer
      for (const t of armed) expect(t.hasRef()).toBe(true);

      controller.abort(); // the waiter leaves: its timers are cleared, nothing is left armed for it
      await expect(queued).rejects.toBeDefined();
      for (const t of armed) clearTimeout(t);
    });

    it('a bare node process with two paced acquires stays alive until the second is granted', () => {
      jest.useRealTimers();
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const path = require('path') as typeof import('path');
      const root = path.resolve(__dirname, '../../..');
      const script = [
        "const { HostLimiter } = require('./packages/common/src/http/crawl/host-limiter');",
        'const limiter = new HostLimiter();',
        "const o = { maxConcurrent: 1, minIntervalMs: 300, jitterMs: 0, maxWaitMs: 0, adaptive: false };",
        '(async () => {',
        "  (await limiter.acquire('k', o))();",
        "  (await limiter.acquire('k', o))();",
        "  process.stdout.write('second granted');",
        '})();',
      ].join('\n');
      const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: path.join(root, 'tsconfig.base.json') },
      });

      expect(child.error).toBeUndefined();
      expect(child.stdout).toContain('second granted');
      expect(child.status).toBe(0);
    }, 150_000);
  });

  describe('cool-down bounds (Spec 1690 §4.5)', () => {
    it('clamps a penalty to maxCooldownMs (default 1 h)', () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 99_999_999_999_000);
      expect(limiter.coolingDownUntil('k') - T0).toBe(3_600_000);
      expect(limiter.maxCooldownMs).toBe(3_600_000);

      const custom = new HostLimiter({ maxCooldownMs: 5000 });
      custom.penalize('k', 60_000);
      expect(custom.coolingDownUntil('k') - T0).toBe(5000);
    });

    it(`reads ${HOST_LIMITER_ENV.MAX_COOLDOWN_MS}`, () => {
      expect(hostLimiterOptionsFromEnv({ [HOST_LIMITER_ENV.MAX_COOLDOWN_MS]: '120000' })).toEqual({ maxCooldownMs: 120_000 });
    });

    it('maxCoolDownWaitMs: fails fast at acquire when the cool-down is longer; waits when it is shorter', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 90_000);
      await expect(limiter.acquire('k', { ...opts(), maxCoolDownWaitMs: 60_000 })).rejects.toBeInstanceOf(HostCoolingDownError);

      const { starts } = track(limiter, 'k', { ...opts(), maxCoolDownWaitMs: 120_000 } as HostLimiterAcquireOptions, 1);
      await jest.advanceTimersByTimeAsync(90_000);
      expect(starts).toEqual([90_000]);
    });

    it('a later penalize that pushes a queued request past its maxCoolDownWaitMs rejects it at once', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 10_000);
      const queued = track(limiter, 'k', { ...opts(), maxCoolDownWaitMs: 60_000 } as HostLimiterAcquireOptions, 1);
      const patient = track(limiter, 'k', opts(), 1);
      await flush();
      expect(queued.errors).toEqual([]);

      limiter.penalize('k', 3_600_000);
      await flush();

      expect(queued.errors).toHaveLength(1);
      expect(queued.errors[0]).toBeInstanceOf(HostCoolingDownError);
      expect(patient.errors).toEqual([]); // no limit: still waiting
    });

    it('with maxWaitMs, a later penalize beyond the wait left rejects with HostCoolingDownError, not a timeout', async () => {
      const limiter = new HostLimiter();
      limiter.penalize('k', 1000);
      const queued = track(limiter, 'k', opts({ maxWaitMs: 20_000 }), 1);
      await jest.advanceTimersByTimeAsync(500);

      limiter.penalize('k', 30_000);
      await flush();

      expect(queued.errors[0]).toBeInstanceOf(HostCoolingDownError);
    });
  });

  describe('very long waits', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('a cool-down beyond the 24.8-day setTimeout limit neither busy-loops nor releases early', async () => {
      const spy = jest.spyOn(global, 'setTimeout');
      const limiter = new HostLimiter({ maxCooldownMs: 50 * DAY });
      limiter.penalize('k', 40 * DAY);
      const { starts } = track(limiter, 'k', opts(), 1);
      await jest.advanceTimersByTimeAsync(DAY);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(spy.mock.calls.every(([, ms]) => (ms ?? 0) <= 2_147_483_647)).toBe(true);
      await jest.advanceTimersByTimeAsync(38 * DAY);
      expect(starts).toEqual([]);
      await jest.advanceTimersByTimeAsync(DAY);
      expect(starts).toEqual([40 * DAY]);
    });

    it('a maxWaitMs beyond the setTimeout limit expires on time, not after 1 ms', async () => {
      const limiter = new HostLimiter();
      track(limiter, 'k', opts({ maxConcurrent: 1 }), 1, false);
      const waiting = track(limiter, 'k', opts({ maxConcurrent: 1, maxWaitMs: 30 * DAY }), 1);
      await jest.advanceTimersByTimeAsync(29 * DAY);
      expect(waiting.errors).toEqual([]);
      await jest.advanceTimersByTimeAsync(DAY);
      expect(waiting.errors).toHaveLength(1);
      expect(waiting.errors[0]).toBeInstanceOf(CrawlQueueTimeoutError);
    });
  });

  describe('singleton', () => {
    it('getHostLimiter returns one shared instance; resetHostLimiter replaces or drops it', () => {
      const first = getHostLimiter();
      expect(getHostLimiter()).toBe(first);
      const custom = new HostLimiter({ maxBuckets: 5 });
      resetHostLimiter(custom);
      expect(getHostLimiter()).toBe(custom);
      resetHostLimiter();
      const fresh = getHostLimiter();
      expect(fresh).not.toBe(first);
      expect(fresh).not.toBe(custom);
    });

    it(`reads ${HOST_LIMITER_ENV.MAX_BUCKETS}, ignoring invalid values with a warning`, () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(hostLimiterOptionsFromEnv({ [HOST_LIMITER_ENV.MAX_BUCKETS]: '250' })).toEqual({ maxBuckets: 250 });
      expect(hostLimiterOptionsFromEnv({})).toEqual({});
      expect(hostLimiterOptionsFromEnv({ [HOST_LIMITER_ENV.MAX_BUCKETS]: 'lots' })).toEqual({});
      expect(hostLimiterOptionsFromEnv({ [HOST_LIMITER_ENV.MAX_BUCKETS]: '-3' })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('bucketKeyFor — Spec 1690 §4.3', () => {
  it('host scope: lower-cased hostname, trailing dot stripped, default port dropped', () => {
    expect(bucketKeyFor('https://ACME.Softy.PRO./offers?page=2', 'host')).toBe('host:acme.softy.pro');
    expect(bucketKeyFor('http://acme.softy.pro:80/x', 'host')).toBe('host:acme.softy.pro');
    expect(bucketKeyFor('https://acme.softy.pro:443/x', 'host')).toBe('host:acme.softy.pro');
    expect(bucketKeyFor('http://acme.softy.pro/x', 'host')).toBe(bucketKeyFor('https://acme.softy.pro/y', 'host'));
  });

  it('host scope keeps a non-default port', () => {
    expect(bucketKeyFor('https://api.example.com:8443/v1', 'host')).toBe('host:api.example.com:8443');
    expect(bucketKeyFor('http://api.example.com:443/', 'host')).toBe('host:api.example.com:443');
  });

  it('host scope ignores userinfo and accepts bare hosts and IPv6 literals', () => {
    expect(bucketKeyFor('https://user:pw@jobs.example.com/', 'host')).toBe('host:jobs.example.com');
    expect(bucketKeyFor('jobs.example.com/careers', 'host')).toBe('host:jobs.example.com');
    expect(bucketKeyFor('jobs.example.com', 'host')).toBe('host:jobs.example.com');
    expect(bucketKeyFor('http://[2001:DB8::1]:8080/', 'host')).toBe('host:[2001:db8::1]:8080');
  });

  it('domain scope groups every tenant of a platform under its registrable domain', () => {
    expect(bucketKeyFor('https://acme.softy.pro/offers', 'domain')).toBe('domain:softy.pro');
    expect(bucketKeyFor('https://other.softy.pro/', 'domain')).toBe('domain:softy.pro');
    expect(bucketKeyFor('https://jobs.bbc.co.uk/', 'domain')).toBe('domain:bbc.co.uk');
    expect(bucketKeyFor('https://softy.pro/', 'domain')).toBe('domain:softy.pro');
  });

  it('domain scope falls back to the hostname for IPs, localhost and unknown suffixes', () => {
    expect(bucketKeyFor('http://93.184.216.34/', 'domain')).toBe('domain:93.184.216.34');
    expect(bucketKeyFor('http://localhost:3000/', 'domain')).toBe('domain:localhost');
    expect(bucketKeyFor('http://[::1]/', 'domain')).toBe('domain:[::1]');
  });

  it('domain scope uses ICANN suffixes only unless private PSL domains are allowed', () => {
    expect(bucketKeyFor('https://acme.github.io/', 'domain')).toBe('domain:github.io');
    expect(bucketKeyFor('https://acme.github.io/', 'domain', undefined, { allowPrivateDomains: true })).toBe(
      'domain:acme.github.io',
    );
  });

  it('site scope keys by site, falling back to the host key', () => {
    expect(bucketKeyFor('https://acme.softy.pro/', 'site', 'softy')).toBe('site:softy');
    expect(bucketKeyFor('https://acme.softy.pro/', 'site')).toBe('host:acme.softy.pro');
    expect(bucketKeyFor('https://acme.softy.pro/', 'site', '  ')).toBe('host:acme.softy.pro');
  });

  it('never throws on garbage', () => {
    expect(bucketKeyFor('', 'host')).toBe('host:');
    expect(bucketKeyFor('::::', 'domain')).toBe('domain:::::');
  });
});
