import { Logger } from '@nestjs/common';
import { getDomain } from 'tldts';

import { CrawlQueueTimeoutError, HostCoolingDownError } from './errors';
import { HostBucketSnapshot, HostLimiterAcquireOptions, HostOutcome, RateLimitScope } from './types';

/**
 * Tunables of the process-wide limiter. Every field is optional; the defaults
 * are `HOST_LIMITER_DEFAULTS`.
 */
export interface HostLimiterOptions {
  /**
   * Soft cap on remembered buckets (LRU). Idle buckets are evicted oldest first;
   * a bucket with requests in flight or queued, or still cooling down / inside
   * its spacing window, is never evicted, so the map may briefly exceed the cap.
   */
  maxBuckets?: number;
  /** Clock (epoch ms). Injectable for tests. */
  now?: () => number;
  /** Uniform random in [0, 1). Injectable for tests (jitter). */
  random?: () => number;
  /** Gap applied to a throttled bucket whose own `minIntervalMs` is 0, ms (× slowdown). */
  adaptiveFloorMs?: number;
  /** Upper bound of the adaptive multiplier. */
  maxSlowdown?: number;
  /** Multiplier applied on every `throttled` outcome. */
  slowdownFactor?: number;
  /** Multiplier applied on every `ok` outcome (the slowdown never drops below 1). */
  recoveryFactor?: number;
  /**
   * Ceiling on any cool-down `penalize` sets, ms (default 1 h). A server's
   * `Retry-After` (or a robots.txt `Crawl-delay`, see `HttpClient`) is taken at its
   * word only up to this, so one hostile response cannot wedge a shared bucket
   * for the life of the process. `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS`.
   */
  maxCooldownMs?: number;
}

/** Options of `HostLimiter.acquire` beyond the Spec 1690 contract (`HostLimiterAcquireOptions`). */
export interface HostLimiterAcquireExtraOptions {
  /**
   * Fail fast with `HostCoolingDownError` when the bucket is cooling down for
   * longer than this, ms — at `acquire`, and whenever a later `penalize` extends
   * the cool-down of a queued request past it. 0 / unset = wait it out (bounded
   * by `maxWaitMs` and the `signal`). `HttpClient` passes `maxRetryAfterMs` when
   * `maxQueueWaitMs` is 0: a request never waits longer for a cool-down than it
   * would ever wait for the server itself.
   */
  maxCoolDownWaitMs?: number;
}

export const HOST_LIMITER_DEFAULTS = {
  maxBuckets: 10_000,
  maxCooldownMs: 3_600_000,
  adaptiveFloorMs: 500,
  maxSlowdown: 16,
  slowdownFactor: 2,
  recoveryFactor: 0.8,
} as const;

/** Environment variables read by `getHostLimiter()` when it builds the singleton. */
export const HOST_LIMITER_ENV = {
  /** Soft cap on remembered rate-limit buckets (default 10000). */
  MAX_BUCKETS: 'EVER_JOBS_CRAWL_MAX_BUCKETS',
  /** Ceiling on a bucket's cool-down (Retry-After, Crawl-delay), ms (default 3600000 = 1 h). */
  MAX_COOLDOWN_MS: 'EVER_JOBS_CRAWL_MAX_COOLDOWN_MS',
} as const;

/** Options for `bucketKeyFor`. */
export interface BucketKeyOptions {
  /**
   * `domain` scope only: also treat the PRIVATE section of the Public Suffix
   * List as suffixes (so `a.github.io` and `b.github.io` are different buckets).
   * Default `false` — ICANN suffixes only, so every tenant of a hosting platform
   * shares the platform's budget, which is what `domain` scope is for.
   */
  allowPrivateDomains?: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Longest delay `setTimeout` honours (~24.8 days). Anything longer overflows to
 * 1 ms — a hostile `Retry-After: 99999999` would otherwise become a busy loop — so
 * longer waits are armed in chunks and re-checked on each wake-up.
 */
const MAX_TIMER_MS = 2_147_483_647;

interface Limits {
  maxConcurrent: number;
  minIntervalMs: number;
  jitterMs: number;
  maxWaitMs: number;
  adaptive: boolean;
  /** 0 = no limit. */
  maxCoolDownWaitMs: number;
}

interface Waiter {
  limits: Limits;
  enqueuedAt: number;
  /** Epoch ms after which the waiter gives up (`maxWaitMs > 0` only). */
  expiresAt?: number;
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  timeout?: Timer;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Bucket {
  key: string;
  active: number;
  queue: Waiter[];
  /** Epoch ms before which the next request may not start (spacing). */
  nextStartAt: number;
  /** Epoch ms until which nothing starts (server asked us to back off). */
  coolingDownUntil: number;
  /** Adaptive multiplier, 1 = no slowdown. */
  slowdown: number;
  pumpTimer?: Timer;
  pumpAt?: number;
}

/** Non-negative finite number, else `fallback`. */
function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toLimits(options: HostLimiterAcquireOptions & HostLimiterAcquireExtraOptions): Limits {
  return {
    maxConcurrent: Math.floor(nonNegative(options.maxConcurrent)),
    minIntervalMs: nonNegative(options.minIntervalMs),
    jitterMs: nonNegative(options.jitterMs),
    maxWaitMs: nonNegative(options.maxWaitMs),
    adaptive: options.adaptive === true,
    maxCoolDownWaitMs: nonNegative(options.maxCoolDownWaitMs),
  };
}

/** The reason an `AbortSignal` carries, or a standard-shaped `AbortError`. */
export function abortReasonOf(signal: AbortSignal): unknown {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Process-wide per-bucket limiter (Spec 1690 §4.3).
 *
 * A request is granted a slot when (a) fewer than `maxConcurrent` requests of
 * its bucket are in flight (0 = unlimited), (b) `now >= nextStartAt`, where each
 * grant sets `nextStartAt = now + minIntervalMs × slowdown + random(0..jitterMs)`,
 * and (c) the bucket is not cooling down. Waiters are served FIFO per bucket; a
 * single timer per bucket pumps the queue. Buckets are LRU-bounded.
 *
 * Timers are NOT unref'd: a timer only exists while a request waits for its slot,
 * and that request must keep the process alive until it is granted (a CLI run or
 * a standalone script would otherwise exit mid-scrape between two paced
 * requests). Cool-downs are capped at `maxCooldownMs`.
 *
 * The adaptive state (`slowdown`) is recorded for every bucket, but only applied
 * to requests that ask for it (`adaptive: true`) — so a `legacy`-preset request
 * is never slowed by it, while a polite one sharing the bucket is.
 */
export class HostLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly adaptiveFloorMs: number;
  private readonly maxSlowdown: number;
  private readonly slowdownFactor: number;
  private readonly recoveryFactor: number;
  private readonly cooldownCeilingMs: number;

  constructor(options: HostLimiterOptions = {}) {
    this.maxBuckets = Math.floor(positive(options.maxBuckets, HOST_LIMITER_DEFAULTS.maxBuckets));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.adaptiveFloorMs = nonNegative(options.adaptiveFloorMs, HOST_LIMITER_DEFAULTS.adaptiveFloorMs);
    this.maxSlowdown = Math.max(1, positive(options.maxSlowdown, HOST_LIMITER_DEFAULTS.maxSlowdown));
    this.slowdownFactor = Math.max(1, positive(options.slowdownFactor, HOST_LIMITER_DEFAULTS.slowdownFactor));
    const recovery = positive(options.recoveryFactor, HOST_LIMITER_DEFAULTS.recoveryFactor);
    this.recoveryFactor = recovery < 1 ? recovery : HOST_LIMITER_DEFAULTS.recoveryFactor;
    this.cooldownCeilingMs = positive(options.maxCooldownMs, HOST_LIMITER_DEFAULTS.maxCooldownMs);
  }

  /** Longest cool-down `penalize` sets, ms (`maxCooldownMs`). */
  get maxCooldownMs(): number {
    return this.cooldownCeilingMs;
  }

  /** Number of buckets currently remembered. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Wait for a slot; resolves to a `release` function that MUST be called exactly
   * once when the request (attempt) finishes. Calling it again is a no-op.
   *
   * Rejects with:
   * - `HostCoolingDownError` immediately, when `maxWaitMs > 0` (or
   *   `maxCoolDownWaitMs > 0`) and the bucket is cooling down for longer than that
   *   (no point queueing — Spec 1690 §4.5); also later, when a `penalize` extends
   *   the cool-down of a queued request past it;
   * - `CrawlQueueTimeoutError` when the slot is not granted within `maxWaitMs`;
   * - the signal's `reason` (or an `AbortError`) when `signal` aborts first; the
   *   waiter leaves the queue.
   */
  acquire(key: string, options: HostLimiterAcquireOptions & HostLimiterAcquireExtraOptions): Promise<() => void> {
    const limits = toLimits(options);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortReasonOf(signal));

    const bucket = this.touch(key);
    const now = this.now();
    const coolingFor = bucket.coolingDownUntil - now;
    if (coolingFor > 0 && this.coolDownTooLong(limits, coolingFor, limits.maxWaitMs)) {
      return Promise.reject(new HostCoolingDownError(key, coolingFor));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { limits, enqueuedAt: now, settled: false, resolve, reject };
      bucket.queue.push(waiter);

      if (limits.maxWaitMs > 0) {
        waiter.expiresAt = now + limits.maxWaitMs;
        this.armExpiry(bucket, waiter, limits.maxWaitMs);
      }
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => this.drop(bucket, waiter, abortReasonOf(signal));
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.pump(bucket);
    });
  }

  /**
   * Hold every request in `key` until now + `ms` (e.g. a `Retry-After`), at most
   * `maxCooldownMs`. Never shortens a cool-down. Queued requests that would now
   * wait longer than their `maxWaitMs` / `maxCoolDownWaitMs` fail fast with
   * `HostCoolingDownError`.
   */
  penalize(key: string, ms: number): void {
    const delay = Math.min(nonNegative(ms), this.cooldownCeilingMs);
    if (delay <= 0) return;
    const bucket = this.touch(key);
    const now = this.now();
    bucket.coolingDownUntil = Math.max(bucket.coolingDownUntil, now + delay);
    // A queued waiter may have a pump timer that fires before the cool-down ends;
    // pump() re-checks and reschedules.
    const coolingFor = bucket.coolingDownUntil - now;
    for (const waiter of [...bucket.queue]) {
      const budget = waiter.expiresAt !== undefined ? Math.max(0, waiter.expiresAt - now) : 0;
      if (this.coolDownTooLong(waiter.limits, coolingFor, budget)) {
        this.drop(bucket, waiter, new HostCoolingDownError(key, coolingFor));
      }
    }
  }

  /**
   * Feed the adaptive throttle: `throttled` (429/503) multiplies the bucket's
   * slowdown (default ×2, cap 16); `ok` decays it (default ×0.8, floor 1);
   * `error` leaves it alone.
   */
  recordOutcome(key: string, outcome: HostOutcome): void {
    if (outcome === 'error') return;
    const bucket = this.touch(key);
    if (outcome === 'throttled') {
      bucket.slowdown = Math.min(this.maxSlowdown, bucket.slowdown * this.slowdownFactor);
    } else if (outcome === 'ok' && bucket.slowdown > 1) {
      bucket.slowdown = Math.max(1, bucket.slowdown * this.recoveryFactor);
    }
  }

  /** Epoch ms until which `key` is cooling down, or 0. Does not create or touch a bucket. */
  coolingDownUntil(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    return bucket.coolingDownUntil > this.now() ? bucket.coolingDownUntil : 0;
  }

  /** Current adaptive multiplier for `key` (1 when unknown). Does not touch the bucket. */
  slowdownOf(key: string): number {
    return this.buckets.get(key)?.slowdown ?? 1;
  }

  snapshot(): HostBucketSnapshot[] {
    const now = this.now();
    const out: HostBucketSnapshot[] = [];
    for (const bucket of this.buckets.values()) {
      const snap: HostBucketSnapshot = {
        key: bucket.key,
        active: bucket.active,
        queued: bucket.queue.length,
        slowdown: bucket.slowdown,
      };
      if (bucket.coolingDownUntil > now) snap.coolingDownUntil = bucket.coolingDownUntil;
      out.push(snap);
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Whether a `coolingFor` ms cool-down exceeds what `limits` wait for:
   * `waitBudgetMs` (the `maxWaitMs` left, when `maxWaitMs > 0`) or `maxCoolDownWaitMs`.
   */
  private coolDownTooLong(limits: Limits, coolingFor: number, waitBudgetMs: number): boolean {
    if (limits.maxWaitMs > 0 && coolingFor > waitBudgetMs) return true;
    return limits.maxCoolDownWaitMs > 0 && coolingFor > limits.maxCoolDownWaitMs;
  }

  /** Get-or-create `key`, mark it most recently used, and evict idle buckets over the cap. */
  private touch(key: string): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      return bucket;
    }
    bucket = { key, active: 0, queue: [], nextStartAt: 0, coolingDownUntil: 0, slowdown: 1 };
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxBuckets) this.evict(key);
    return bucket;
  }

  private evict(keep: string): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (this.buckets.size <= this.maxBuckets) return;
      if (key === keep) continue;
      if (this.isIdle(bucket, now)) this.buckets.delete(key);
    }
  }

  private isIdle(bucket: Bucket, now: number): boolean {
    return (
      bucket.active === 0 &&
      bucket.queue.length === 0 &&
      bucket.pumpTimer === undefined &&
      bucket.coolingDownUntil <= now &&
      bucket.nextStartAt <= now
    );
  }

  /** Grant as many queued waiters as the bucket's state allows, then arm a timer if needed. */
  private pump(bucket: Bucket): void {
    while (bucket.queue.length > 0) {
      const head = bucket.queue[0];
      const max = head.limits.maxConcurrent;
      if (max > 0 && bucket.active >= max) return; // release() pumps again

      const now = this.now();
      const readyAt = Math.max(bucket.nextStartAt, bucket.coolingDownUntil);
      if (now < readyAt) {
        this.schedulePump(bucket, readyAt, now);
        return;
      }

      bucket.queue.shift();
      this.grant(bucket, head, now);
    }
  }

  private schedulePump(bucket: Bucket, at: number, now: number): void {
    if (bucket.pumpTimer !== undefined && bucket.pumpAt !== undefined && bucket.pumpAt <= at) return;
    if (bucket.pumpTimer !== undefined) clearTimeout(bucket.pumpTimer);
    bucket.pumpAt = at;
    // pump() re-checks readiness on wake-up, so a chunked (clamped) wait simply re-arms.
    // Not unref'd: a queued request is waiting on it (see the class comment).
    bucket.pumpTimer = setTimeout(() => {
      bucket.pumpTimer = undefined;
      bucket.pumpAt = undefined;
      this.pump(bucket);
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - now)));
  }

  private armExpiry(bucket: Bucket, waiter: Waiter, delay: number): void {
    const clamped = delay > MAX_TIMER_MS;
    waiter.timeout = setTimeout(
      () => {
        const remaining = (waiter.expiresAt ?? 0) - this.now();
        if (clamped && remaining > 0 && !waiter.settled) this.armExpiry(bucket, waiter, remaining);
        else this.expire(bucket, waiter);
      },
      Math.min(MAX_TIMER_MS, delay),
    );
  }

  private gapFor(bucket: Bucket, limits: Limits): number {
    let base = limits.minIntervalMs;
    if (limits.adaptive && bucket.slowdown > 1) {
      base = Math.ceil((base > 0 ? base : this.adaptiveFloorMs) * bucket.slowdown);
    }
    const jitter = limits.jitterMs > 0 ? Math.floor(this.random() * (limits.jitterMs + 1)) : 0;
    return base + Math.min(jitter, limits.jitterMs);
  }

  private grant(bucket: Bucket, waiter: Waiter, now: number): void {
    this.settle(waiter);
    bucket.active++;
    bucket.nextStartAt = now + this.gapFor(bucket, waiter.limits);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      bucket.active = Math.max(0, bucket.active - 1);
      this.pump(bucket);
    };
    waiter.resolve(release);
  }

  private expire(bucket: Bucket, waiter: Waiter): void {
    if (waiter.settled) return;
    const waited = Math.max(waiter.limits.maxWaitMs, this.now() - waiter.enqueuedAt);
    this.drop(bucket, waiter, new CrawlQueueTimeoutError(bucket.key, Math.round(waited)));
  }

  /** Remove a still-queued waiter and reject it. */
  private drop(bucket: Bucket, waiter: Waiter, reason: unknown): void {
    if (waiter.settled) return;
    const index = bucket.queue.indexOf(waiter);
    if (index >= 0) bucket.queue.splice(index, 1);
    this.settle(waiter);
    waiter.reject(reason);
    // The head may have changed (and with it maxConcurrent), so re-evaluate.
    this.pump(bucket);
  }

  private settle(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.timeout = undefined;
    waiter.onAbort = undefined;
  }
}

const logger = new Logger('HostLimiter');
let singleton: HostLimiter | undefined;

/** A positive-integer variable: unset → undefined; invalid → undefined with a warning. */
function envPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`Ignoring ${name}=${JSON.stringify(raw)}: expected a positive integer`);
    return undefined;
  }
  return value;
}

/** Read `HOST_LIMITER_ENV` into limiter options; invalid values are ignored with a warning. */
export function hostLimiterOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HostLimiterOptions {
  const options: HostLimiterOptions = {};
  const maxBuckets = envPositiveInt(env, HOST_LIMITER_ENV.MAX_BUCKETS);
  if (maxBuckets !== undefined) options.maxBuckets = maxBuckets;
  const maxCooldownMs = envPositiveInt(env, HOST_LIMITER_ENV.MAX_COOLDOWN_MS);
  if (maxCooldownMs !== undefined) options.maxCooldownMs = maxCooldownMs;
  return options;
}

/**
 * The process-wide limiter (created on first use; `EVER_JOBS_CRAWL_MAX_BUCKETS` sets
 * its cap, `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS` its cool-down ceiling).
 */
export function getHostLimiter(): HostLimiter {
  if (!singleton) singleton = new HostLimiter(hostLimiterOptionsFromEnv());
  return singleton;
}

/** Replace the process-wide limiter (tests). Without an argument the next `getHostLimiter()` builds a fresh one. */
export function resetHostLimiter(limiter?: HostLimiter): void {
  singleton = limiter;
}

/**
 * Lower-cased hostname of `url` (no trailing dot; IPv6 keeps its brackets) plus
 * `:port` when the port is not the scheme's default — i.e. WHATWG `URL.host`.
 * Accepts absolute URLs and bare `host[:port][/path]` strings.
 */
function hostOf(url: string): { host: string; hostname: string } {
  const raw = (url ?? '').trim();
  const candidates = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? [raw] : [`http://${raw}`, raw];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
      if (!hostname) continue;
      return { hostname, host: parsed.port ? `${hostname}:${parsed.port}` : hostname };
    } catch {
      // try the next form
    }
  }
  const fallback = raw.toLowerCase();
  return { hostname: fallback, host: fallback };
}

/**
 * Bucket key for a URL (Spec 1690 §4.3):
 *
 * - `host`   → `host:<hostname>[:<port>]` — lower-cased, trailing dot stripped;
 *   the port is kept only when it is not the scheme's default (a non-default
 *   port is usually a separately operated service, and robots.txt is per origin
 *   too). `http://x.com` and `https://x.com` share one bucket.
 * - `domain` → `domain:<registrable domain>` via tldts (`acme.softy.pro` →
 *   `softy.pro`); IP literals, `localhost` and unknown suffixes fall back to the
 *   hostname.
 * - `site`   → `site:<site>`; falls back to the `host` key when no site is known.
 */
export function bucketKeyFor(url: string, scope: RateLimitScope, site?: string, options: BucketKeyOptions = {}): string {
  if (scope === 'site') {
    const name = (site ?? '').trim();
    if (name) return `site:${name}`;
  }
  const { host, hostname } = hostOf(url);
  if (scope === 'domain') {
    let domain: string | null = null;
    try {
      domain = getDomain(hostname, { allowPrivateDomains: options.allowPrivateDomains === true });
    } catch {
      domain = null;
    }
    return `domain:${domain || hostname}`;
  }
  return `host:${host}`;
}
