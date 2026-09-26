import { BoundedTtlCache } from '../src/http/crawl/ttl-cache';
import { BoundedTtlCache as FromIndex } from '../src/http/crawl';

/** A controllable clock. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('BoundedTtlCache (Spec 1691)', () => {
  it('is exported from the crawl index', () => {
    expect(FromIndex).toBe(BoundedTtlCache);
  });

  it('stores and returns values', () => {
    const cache = new BoundedTtlCache<number>(10, 1000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.has('missing')).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('overwrites an existing key without growing', () => {
    const cache = new BoundedTtlCache<string>(10, 0);
    cache.set('a', 'x');
    cache.set('a', 'y');
    expect(cache.get('a')).toBe('y');
    expect(cache.size).toBe(1);
  });

  it('expires entries after the TTL (injectable clock)', () => {
    const c = clock();
    const cache = new BoundedTtlCache<string>(10, 1000, c.now);
    cache.set('a', 'x');
    c.advance(999);
    expect(cache.get('a')).toBe('x');
    c.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('a get hit does not extend the TTL', () => {
    const c = clock();
    const cache = new BoundedTtlCache<string>(10, 1000, c.now);
    cache.set('a', 'x');
    c.advance(600);
    expect(cache.get('a')).toBe('x');
    c.advance(600);
    expect(cache.get('a')).toBeUndefined();
  });

  it('has() reports expiry and removes the stale entry', () => {
    const c = clock();
    const cache = new BoundedTtlCache<string>(10, 100, c.now);
    cache.set('a', 'x');
    c.advance(100);
    expect(cache.has('a')).toBe(false);
    expect(cache.delete('a')).toBe(false);
  });

  it('evicts the least recently USED entry at the cap (get re-inserts)', () => {
    const cache = new BoundedTtlCache<number>(3, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Touch `a` so `b` becomes the least recently used.
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('has() does not change recency', () => {
    const cache = new BoundedTtlCache<number>(2, 0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.has('a')).toBe(true);
    cache.set('c', 3);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('never holds more than maxEntries (hard cap under many inserts)', () => {
    const cache = new BoundedTtlCache<number>(50, 0);
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(50);
    expect(cache.get('k999')).toBe(999);
    expect(cache.get('k949')).toBeUndefined();
    expect(cache.get('k950')).toBe(950);
  });

  it('evicts expired entries before live ones when over the cap', () => {
    const c = clock();
    const cache = new BoundedTtlCache<number>(2, 0, c.now);
    cache.set('short', 1, 100);
    cache.set('live', 2);
    c.advance(100);
    cache.set('new', 3);
    expect(cache.get('live')).toBe(2);
    expect(cache.get('new')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('per-entry TTL overrides the default', () => {
    const c = clock();
    const cache = new BoundedTtlCache<number>(10, 1000, c.now);
    cache.set('long', 1, 5000);
    cache.set('forever', 2, 0);
    cache.set('default', 3);
    c.advance(1000);
    expect(cache.get('default')).toBeUndefined();
    expect(cache.get('long')).toBe(1);
    c.advance(10_000_000);
    expect(cache.get('long')).toBeUndefined();
    expect(cache.get('forever')).toBe(2);
  });

  it('ttlMs <= 0 means no expiry', () => {
    const c = clock();
    const cache = new BoundedTtlCache<number>(10, 0, c.now);
    cache.set('a', 1);
    c.advance(Number.MAX_SAFE_INTEGER / 2);
    expect(cache.get('a')).toBe(1);
    const negative = new BoundedTtlCache<number>(10, -5, c.now);
    negative.set('b', 2);
    c.advance(1e9);
    expect(negative.get('b')).toBe(2);
  });

  it('maxEntries <= 0 disables the cache', () => {
    for (const max of [0, -1, Number.NaN]) {
      const cache = new BoundedTtlCache<number>(max, 1000);
      cache.set('a', 1);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    }
  });

  it('keeps the constructor arguments readable', () => {
    const cache = new BoundedTtlCache<number>(7, 42);
    expect(cache.maxEntries).toBe(7);
    expect(cache.ttlMs).toBe(42);
  });

  it('delete / clear / prune', () => {
    const c = clock();
    const cache = new BoundedTtlCache<number>(10, 100, c.now);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3, 0);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    c.advance(100);
    expect(cache.prune()).toBe(1); // `b` expired; `c` never expires
    expect(cache.get('c')).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('c')).toBeUndefined();
  });

  it('uses Date.now by default', () => {
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(10_000);
      const cache = new BoundedTtlCache<number>(10, 1000);
      cache.set('a', 1);
      spy.mockReturnValue(10_999);
      expect(cache.get('a')).toBe(1);
      spy.mockReturnValue(11_000);
      expect(cache.get('a')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
