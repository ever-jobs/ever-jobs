import 'reflect-metadata';
import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';

import { HttpClient } from '../src/http/http-client';
import { CRAWL_ENV } from '../src/http/crawl/defaults';
import { CRAWL_EXTRA_ENV, crawlCooldownBeforeRelease, readCrawlPolicyEnv, resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { HostCoolingDownError } from '../src/http/crawl/errors';
import { HostLimiter, resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetRobotsTxtCache } from '../src/http/crawl/robots';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

/**
 * Review of PR #105 (G1) — `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE`.
 *
 * A failed attempt used to free its limiter slot (`release()`, in a `finally`) BEFORE
 * it recorded the failure and cooled the bucket. Freeing a slot pumps the queue, and
 * `HostLimiter.pump()` grants an eligible waiter synchronously — so a request queued
 * behind a 502 / 503 / 429 was granted and sent at once, inside the cool-down that
 * the next few lines were about to set (the grant is never taken back). With the
 * default `locked`, a request under a lock (here the operator's global `stricter`, and
 * every request to `*.softy.pro`) records the outcome and cool-down first, then frees
 * the slot; a source WITHOUT a lock keeps the pre-fix order, byte for byte (Spec 1714
 * rule 3); `all` extends the fix to every request; `off` (the `legacy` default) is the
 * pre-fix order everywhere.
 *
 * Harness: the REAL axios pipeline into a fake adapter, fake timers (the limiter and
 * the stamps read the same faked clock, so the times are exact), one slot per host
 * and no start-to-start interval — the queued request is eligible the instant the
 * slot is freed, which is exactly the window the old order left open.
 *
 * Red controls: `off` (and an unlocked source under the default) — the queued request
 * starts the moment the first one failed, inside the cool-down.
 */

const URL_1 = 'https://jobs.example.com/offers/1';
const URL_2 = 'https://jobs.example.com/offers/2';
/** When the first request's answer arrives (fake clock, ms after the start). */
const ANSWER_AFTER_MS = 50;

interface Reply {
  status: number;
  headers?: Record<string, string>;
}

const ENV_KEYS = [...Object.values(CRAWL_ENV), ...Object.values(CRAWL_EXTRA_ENV)];

describe('HttpClient — a failed attempt records its cool-down before freeing its slot (EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE)', () => {
  const saved: Record<string, string | undefined> = {};

  const setEnv = (vars: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    for (const name of ENV_KEYS) saved[name] = process.env[name];
    setEnv(Object.fromEntries(ENV_KEYS.map((name) => [name, undefined])));
    // One slot per host, no interval, no retry: the queued request is eligible as
    // soon as the first frees its slot.
    setEnv({
      [CRAWL_ENV.MAX_CONCURRENT_PER_HOST]: '1',
      [CRAWL_ENV.MIN_INTERVAL_MS]: '0',
      [CRAWL_ENV.RETRIES]: '0',
    });
    resetHostLimiter();
    resetRobotsTxtCache();
  });

  afterEach(() => {
    jest.useRealTimers();
    setEnv(saved);
    resetHostLimiter();
    resetRobotsTxtCache();
  });

  /**
   * Two concurrent GETs to one host: the first answers `first` after
   * ANSWER_AFTER_MS, the second 200. Returns when each reached the adapter (fake
   * clock) and how each settled.
   */
  async function twoQueued(first: Reply, runMs: number): Promise<{ starts: number[]; results: unknown[] }> {
    const limiter = new HostLimiter();
    const client = new HttpClient({ retries: 0, hostLimiter: limiter });
    const starts: number[] = [];
    const t0 = Date.now();
    client.getAxiosInstance().defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const index = starts.length;
      starts.push(Date.now() - t0);
      const reply: Reply = index === 0 ? first : { status: 200 };
      if (index === 0) await new Promise((resolve) => setTimeout(resolve, ANSWER_AFTER_MS));
      const response = {
        data: 'x',
        status: reply.status,
        statusText: String(reply.status),
        headers: new AxiosHeaders(reply.headers ?? {}),
        config,
        request: {},
      };
      if (reply.status < 400) return response;
      throw new AxiosError(
        `Request failed with status code ${reply.status}`,
        reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
        config,
        {},
        response,
      );
    };
    const settled = [client.get(URL_1), client.get(URL_2)].map((p) => p.then((r) => r.status).catch((err: unknown) => err));
    await jest.advanceTimersByTimeAsync(runMs);
    return { starts, results: await Promise.all(settled) };
  }

  const LOCKED = { [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' };

  describe('under a lock (the default `locked`)', () => {
    it('a 502 with serverErrorCooldownMs 300: the queued request starts when the cool-down ends, not inside it', async () => {
      setEnv({ ...LOCKED, [CRAWL_ENV.SERVER_ERROR_COOLDOWN_MS]: '300' });

      const { starts, results } = await twoQueued({ status: 502 }, 2000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS + 300]);
      expect((results[0] as AxiosError).response?.status).toBe(502);
      expect(results[1]).toBe(200);
    });

    it('a 503 (the 5 s throttle floor): the queued request waits for the back-off', async () => {
      setEnv(LOCKED);

      const { starts, results } = await twoQueued({ status: 503 }, 10_000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS + 5000]);
      expect(results[1]).toBe(200);
    });

    it('a 429 with Retry-After: 2: the queued request waits the 2 s', async () => {
      setEnv({ ...LOCKED, [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: '0' });

      const { starts } = await twoQueued({ status: 429, headers: { 'Retry-After': '2' } }, 10_000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS + 2000]);
    });

    it('a 429 whose Retry-After exceeds maxRetryAfterMs (give up): the queued request is never sent', async () => {
      setEnv({ ...LOCKED, [CRAWL_ENV.MAX_QUEUE_WAIT_MS]: '10000' });

      const { starts, results } = await twoQueued({ status: 429, headers: { 'Retry-After': '3600' } }, 20_000);

      expect(starts).toEqual([0]);
      expect(results[0]).toBeInstanceOf(HostCoolingDownError);
      expect(results[1]).toBeInstanceOf(HostCoolingDownError);
    });

    it('red control: EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off (the pre-fix order) — the queued request starts inside the cool-down', async () => {
      setEnv({ ...LOCKED, [CRAWL_ENV.SERVER_ERROR_COOLDOWN_MS]: '300', [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'off' });

      const { starts } = await twoQueued({ status: 502 }, 2000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS]);
    });

    it('red control: off lets the give-up case send the queued request into a 1 h cool-down', async () => {
      setEnv({ ...LOCKED, [CRAWL_ENV.MAX_QUEUE_WAIT_MS]: '10000', [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'off' });

      const { starts, results } = await twoQueued({ status: 429, headers: { 'Retry-After': '3600' } }, 20_000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS]);
      expect(results[1]).toBe(200);
    });
  });

  describe('a site owner lock on the host (*.softy.pro), whoever makes the request', () => {
    /**
     * Every request to *.softy.pro is under the site owner's builtin lock (1 s interval,
     * 500 ms idle gap, 30 s server-error cool-down) — `crawlLockApplies` sees it through
     * the applied builtin pattern, with no operator lock at all. The builtin 500 ms idle
     * gap happens to push the next grant past the synchronous penalty, so the operator
     * turns it off here (`hosts["*.softy.pro"].minGapMs: 0`, which the lock does not
     * forbid an OPERATOR) to open the window the old order left: after a 2 s 502 the
     * 1 s interval has passed, so only the order decides.
     */
    const NO_GAP = JSON.stringify({ hosts: { '*.softy.pro': { minGapMs: 0 } } });

    async function softyAfter502(): Promise<number[]> {
      const limiter = new HostLimiter();
      const client = new HttpClient({ retries: 0, hostLimiter: limiter });
      const starts: number[] = [];
      const t0 = Date.now();
      client.getAxiosInstance().defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        const index = starts.length;
        starts.push(Date.now() - t0);
        // Slower than the 1 s interval + the 500 ms gap, so only the cool-down can hold the next one.
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = { data: 'x', status: index === 0 ? 502 : 200, statusText: '', headers: new AxiosHeaders(), config, request: {} };
        if (index > 0) return response;
        throw new AxiosError('Request failed with status code 502', AxiosError.ERR_BAD_RESPONSE, config, {}, response);
      };
      const settled = ['https://acme.softy.pro/offers/1', 'https://acme.softy.pro/offers/2'].map((url) =>
        client.get(url).then((r) => r.status).catch((err: unknown) => err),
      );
      await jest.advanceTimersByTimeAsync(60_000);
      await Promise.all(settled);
      return starts;
    }

    it('the builtin Softy host lock holds the slot: the next Softy request waits the 30 s cool-down', async () => {
      setEnv({ [CRAWL_ENV.POLICIES]: NO_GAP });

      expect(await softyAfter502()).toEqual([0, 2000 + 30_000]);
    });

    it('red control: EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off — it starts the moment the 502 came back', async () => {
      setEnv({ [CRAWL_ENV.POLICIES]: NO_GAP, [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'off' });

      expect(await softyAfter502()).toEqual([0, 2000]);
    });

    it('with the builtin 500 ms idle gap the pump re-checks after the penalty, so the old order holds it too', async () => {
      setEnv({ [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'off' });

      expect(await softyAfter502()).toEqual([0, 2000 + 30_000]);
    });
  });

  describe('without a lock (rule 3)', () => {
    it('the default keeps the pre-fix order for an unlocked source, byte for byte', async () => {
      setEnv({ [CRAWL_ENV.SERVER_ERROR_COOLDOWN_MS]: '300' });

      const { starts } = await twoQueued({ status: 502 }, 2000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS]);
    });

    it('EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=all applies the fix to it too', async () => {
      setEnv({ [CRAWL_ENV.SERVER_ERROR_COOLDOWN_MS]: '300', [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'all' });

      const { starts } = await twoQueued({ status: 502 }, 2000);

      expect(starts).toEqual([0, ANSWER_AFTER_MS + 300]);
    });
  });

  describe('the switch', () => {
    it('defaults to locked; the legacy preset makes it off; an explicit value wins; junk warns and keeps the default', () => {
      expect(crawlCooldownBeforeRelease(readCrawlPolicyEnv())).toBe('locked');
      setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
      expect(crawlCooldownBeforeRelease(readCrawlPolicyEnv())).toBe('off');
      setEnv({ [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'ALL' });
      expect(crawlCooldownBeforeRelease(readCrawlPolicyEnv())).toBe('all');
      setEnv({ [CRAWL_ENV.PRESET]: undefined, [CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE]: 'sometimes' });
      const env = readCrawlPolicyEnv();
      expect(crawlCooldownBeforeRelease(env)).toBe('locked');
      expect(env.warnings).toEqual([expect.stringContaining(`${CRAWL_EXTRA_ENV.COOLDOWN_BEFORE_RELEASE}: `)]);
    });
  });
});
