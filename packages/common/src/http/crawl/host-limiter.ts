import { HostBucketSnapshot, HostLimiterAcquireOptions, HostOutcome, RateLimitScope } from './types';

/**
 * Process-wide per-bucket limiter: max in flight + minimum gap between starts +
 * cool-down + adaptive slow-down. LRU-bounded. Spec 1690 — implemented by lane B2.
 */
export class HostLimiter {
  constructor(options?: { maxBuckets?: number; now?: () => number; random?: () => number }) {}

  /** Wait for a slot; resolves to a `release` function that MUST be called exactly once. */
  acquire(key: string, options: HostLimiterAcquireOptions): Promise<() => void> {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }

  /** Hold every request in `key` until now + `ms` (e.g. a `Retry-After`). */
  penalize(key: string, ms: number): void {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }

  /** Feed the adaptive throttle. */
  recordOutcome(key: string, outcome: HostOutcome): void {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }

  /** Epoch ms until which `key` is cooling down, or 0. */
  coolingDownUntil(key: string): number {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }

  snapshot(): HostBucketSnapshot[] {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }
}

export function getHostLimiter(): HostLimiter {
  throw new Error('not implemented (Spec 1690 lane B2)');
}

/** Replace the process-wide limiter (tests). */
export function resetHostLimiter(limiter?: HostLimiter): void {
  throw new Error('not implemented (Spec 1690 lane B2)');
}

/** Bucket key for a URL: `host:<h>`, `domain:<registrable>` or `site:<site>`. */
export function bucketKeyFor(url: string, scope: RateLimitScope, site?: string): string {
  throw new Error('not implemented (Spec 1690 lane B2)');
}
