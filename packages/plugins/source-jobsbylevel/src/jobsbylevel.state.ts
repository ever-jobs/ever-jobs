/**
 * Process-wide state for the Level plugin (Spec 1693): a small TTL cache and a
 * per-host pacer. Module level on purpose — the pace limit and the cache are
 * about the host, not about one service instance or one request.
 */

/**
 * Clock and sleep the plugin uses for pacing and for the detail time budget.
 * Replaceable so tests can drive time deterministically; production code
 * never reassigns them.
 */
export const jobsByLevelRuntime: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * Insertion-ordered TTL cache with a size cap: the oldest entry is evicted
 * first. TTL and cap are passed per call so an env override takes effect
 * without a restart. Callers store only successful, validated responses.
 */
export class JobsByLevelTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string, ttlMs: number, now: number): T | undefined {
    if (ttlMs <= 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number, maxEntries: number, now: number): void {
    if (ttlMs <= 0 || maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { at: now, value });
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Listing responses (MCP search pages and the parsed RSS feed). */
export const jobsByLevelPageCache = new JobsByLevelTtlCache<unknown>();
/** Detail responses, keyed by transport and slug. */
export const jobsByLevelDetailCache = new JobsByLevelTtlCache<unknown>();

let nextSlotAt = 0;

/**
 * Reserve the next request slot for the host and return how long to wait for
 * it. Reservation is synchronous, so two scrapes running at once can never
 * both be told "go now": the second one is queued one interval later.
 */
export function reserveJobsByLevelSlot(now: number, intervalMs: number): number {
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + intervalMs;
  return at - now;
}

/** Drop the cache and the pacer's memory (tests, and a process-level reset). */
export function resetJobsByLevelState(): void {
  jobsByLevelPageCache.clear();
  jobsByLevelDetailCache.clear();
  nextSlotAt = 0;
}
