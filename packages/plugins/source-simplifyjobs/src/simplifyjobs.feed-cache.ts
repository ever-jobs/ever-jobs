/**
 * A small conditional-GET cache with single-flight (Spec 1694).
 *
 * One instance lives on the service (a Nest singleton), keyed by URL. It holds
 * the already-compacted value, never a response body. Per key:
 *
 * 1. A request already in flight is shared: concurrent scrapes of one fan-out
 *    cost one download.
 * 2. A copy younger than its TTL is returned with no request.
 * 3. Otherwise the fetcher runs, receiving the cached ETag (for
 *    `If-None-Match`). `not-modified` refreshes the timestamp and keeps the
 *    value; `fresh` replaces it. The TTL comes from `max-age`, clamped.
 * 4. On an error, a copy younger than `staleMaxMs` is served and flagged
 *    `stale`; with none, the error is rethrown. For `errorBackoffMs` after a
 *    failure no new request is made for that key, so an outage is not met with
 *    one retry per search.
 *
 * Time comes from the injected clock, so tests control it.
 */

export type FeedFetchResult<T> =
  | { status: 'fresh'; value: T; etag: string | null; maxAgeMs: number | null }
  | { status: 'not-modified'; etag?: string | null; maxAgeMs: number | null };

export type FeedFetcher<T> = (etag: string | null) => Promise<FeedFetchResult<T>>;

export interface FeedReadResult<T> {
  value: T;
  /** `cache`: fresh, no request. `revalidated`: 304. `fetched`: 200. `stale`: error, older copy served. */
  source: 'cache' | 'revalidated' | 'fetched' | 'stale';
  /** Age of the served copy, in ms, at the time it was served. */
  ageMs: number;
  /** The refresh error behind a `stale` result. */
  error?: unknown;
}

export interface FeedCacheOptions {
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
  staleMaxMs: number;
  errorBackoffMs: number;
  /** Keys kept at most; the least recently refreshed is dropped first. */
  maxEntries: number;
}

interface FeedEntry<T> {
  value: T;
  etag: string | null;
  fetchedAt: number;
  ttlMs: number;
}

interface FeedFailure {
  at: number;
  error: unknown;
}

export class FeedCache<T> {
  private readonly entries = new Map<string, FeedEntry<T>>();
  private readonly inflight = new Map<string, Promise<FeedReadResult<T>>>();
  private readonly failures = new Map<string, FeedFailure>();

  constructor(
    private readonly now: () => number,
    private readonly options: FeedCacheOptions,
  ) {}

  get(key: string, fetcher: FeedFetcher<T>): Promise<FeedReadResult<T>> {
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const entry = this.entries.get(key);
    const now = this.now();
    if (entry && now - entry.fetchedAt < entry.ttlMs) {
      return Promise.resolve({ value: entry.value, source: 'cache', ageMs: now - entry.fetchedAt });
    }

    const failure = this.failures.get(key);
    if (failure && now - failure.at < this.options.errorBackoffMs) {
      return this.staleOrThrow(key, failure.error, now);
    }

    const promise = this.refresh(key, entry, fetcher).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /** The cached value without any request or TTL check (diagnostics and tests). */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  /** Keys currently cached (diagnostics and tests). */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
    this.failures.clear();
  }

  private async refresh(
    key: string,
    entry: FeedEntry<T> | undefined,
    fetcher: FeedFetcher<T>,
  ): Promise<FeedReadResult<T>> {
    let result: FeedFetchResult<T>;
    try {
      result = await fetcher(entry?.etag ?? null);
    } catch (error: unknown) {
      const now = this.now();
      this.failures.set(key, { at: now, error });
      return this.staleOrThrow(key, error, now);
    }

    const now = this.now();
    if (result.status === 'not-modified') {
      if (!entry) {
        const error = new Error('simplifyjobs: 304 Not Modified without a cached copy');
        this.failures.set(key, { at: now, error });
        throw error;
      }
      entry.fetchedAt = now;
      entry.ttlMs = this.ttl(result.maxAgeMs);
      if (result.etag) entry.etag = result.etag;
      this.failures.delete(key);
      return { value: entry.value, source: 'revalidated', ageMs: 0 };
    }

    this.entries.delete(key);
    this.entries.set(key, { value: result.value, etag: result.etag, fetchedAt: now, ttlMs: this.ttl(result.maxAgeMs) });
    this.failures.delete(key);
    this.evict();
    return { value: result.value, source: 'fetched', ageMs: 0 };
  }

  private staleOrThrow(key: string, error: unknown, now: number): Promise<FeedReadResult<T>> {
    const entry = this.entries.get(key);
    if (entry && now - entry.fetchedAt < this.options.staleMaxMs) {
      return Promise.resolve({ value: entry.value, source: 'stale', ageMs: now - entry.fetchedAt, error });
    }
    return Promise.reject(error);
  }

  private ttl(maxAgeMs: number | null): number {
    const raw = maxAgeMs !== null && Number.isFinite(maxAgeMs) ? maxAgeMs : this.options.defaultTtlMs;
    return Math.min(this.options.maxTtlMs, Math.max(this.options.minTtlMs, raw));
  }

  /** Map order is insertion order and a refresh re-inserts, so the first key is the oldest. */
  private evict(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.failures.delete(oldest);
    }
  }
}

/** `max-age` of a `Cache-Control` header, in ms; `null` when absent or unusable. */
export function parseMaxAgeMs(cacheControl: unknown): number | null {
  if (typeof cacheControl !== 'string') return null;
  const match = /(?:^|[,\s])max-age\s*=\s*"?(\d{1,9})"?/i.exec(cacheControl);
  return match ? Number(match[1]) * 1000 : null;
}

/** One response header, case-insensitively, from AxiosHeaders or a plain object. */
export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const lower = name.toLowerCase();
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value: unknown = (getter as (n: string) => unknown).call(headers, lower);
    if (typeof value === 'string') return value;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return null;
}
