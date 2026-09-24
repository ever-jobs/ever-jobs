/**
 * LRU + TTL map with a hard entry cap (heap is tight in prod).
 * Spec 1691 — implemented by lane B5.
 */
export class BoundedTtlCache<V> {
  constructor(readonly maxEntries: number, readonly ttlMs: number, now?: () => number) {}

  get(key: string): V | undefined {
    throw new Error('not implemented (Spec 1691 lane B5)');
  }

  set(key: string, value: V): void {
    throw new Error('not implemented (Spec 1691 lane B5)');
  }

  delete(key: string): boolean {
    throw new Error('not implemented (Spec 1691 lane B5)');
  }

  clear(): void {
    throw new Error('not implemented (Spec 1691 lane B5)');
  }

  get size(): number {
    throw new Error('not implemented (Spec 1691 lane B5)');
  }
}
