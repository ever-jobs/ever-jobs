/**
 * LRU + TTL map with a hard entry cap (heap is tight in prod).
 *
 * - **LRU**: a `get` hit re-inserts the entry, so the least recently *used* entry
 *   is the first one evicted when a `set` pushes the cache past `maxEntries`.
 * - **TTL**: an entry older than its time-to-live is treated as absent and removed
 *   lazily (on `get`/`has`, when counting `size`, or by `prune()`).
 * - **Hard cap**: the map never holds more than `maxEntries` entries.
 *
 * Conventions (Spec 1691):
 * - `maxEntries <= 0` (or not a finite number) disables the cache: `set` stores
 *   nothing and every `get` misses.
 * - `ttlMs <= 0` (or not a finite number) means "no expiry" — entries live until
 *   evicted by the LRU cap, the same convention as `lru-cache`.
 * - `now` is injectable for tests (defaults to `Date.now`).
 */
export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;

  constructor(readonly maxEntries: number, readonly ttlMs: number, now?: () => number) {
    this.capacity = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0;
    this.defaultTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
    this.clock = now ?? Date.now;
  }

  /** The value for `key`, or undefined when absent or expired. A hit marks it most recently used. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry.expiresAt)) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order (oldest first) tracks recency of use.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** True when `key` holds an unexpired value. Does not change recency. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.isExpired(entry.expiresAt)) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Store `value` under `key` as the most recently used entry. `ttlMs` overrides the
   * cache's default TTL for this entry (`<= 0` = no expiry). Evicts expired entries
   * first, then the least recently used ones, until the cap holds.
   */
  set(key: string, value: V, ttlMs?: number): void {
    if (this.capacity === 0) return;
    const ttl = ttlMs === undefined ? this.defaultTtlMs : Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
    const expiresAt = ttl > 0 ? this.clock() + ttl : Number.POSITIVE_INFINITY;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    if (this.entries.size > this.capacity) {
      this.prune();
      while (this.entries.size > this.capacity) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Remove every expired entry; returns how many were removed. */
  prune(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry.expiresAt)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Number of unexpired entries (expired ones are pruned first). */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private isExpired(expiresAt: number): boolean {
    return expiresAt !== Number.POSITIVE_INFINITY && this.clock() >= expiresAt;
  }
}
