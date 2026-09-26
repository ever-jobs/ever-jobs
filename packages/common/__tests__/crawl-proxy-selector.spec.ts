import { createProxyRotationState, fnv1a32, resetProxyScrapeSeed, selectProxy } from '../src/http/crawl/proxy-selector';
import { ProxyRotation } from '../src/http/crawl/types';

/**
 * The pre-1690 `HttpClient.getNextProxy()` + its caller, verbatim in behaviour:
 * round-robin per client, `'localhost'` (or an empty entry) = direct.
 */
function legacyPicker(proxies: string[]) {
  let proxyIndex = 0;
  const getNextProxy = (): string | null => {
    if (proxies.length === 0) return null;
    const proxy = proxies[proxyIndex % proxies.length];
    proxyIndex++;
    return proxy;
  };
  return (): string | null => {
    const proxy = getNextProxy();
    return proxy && proxy !== 'localhost' ? proxy : null;
  };
}

describe('selectProxy — Spec 1690 §4.4', () => {
  const list = ['http://p1:8080', 'socks5://p2:1080', 'p3:3128'];

  it.each<ProxyRotation>(['per-request', 'per-scrape', 'per-host', 'off'])('%s: an empty list is a direct connection', (rotation) => {
    const state = createProxyRotationState();
    expect(selectProxy([], rotation, state, 'host:a.example')).toBeNull();
    expect(selectProxy([], rotation, state, 'host:a.example')).toBeNull();
  });

  it('off: never uses a proxy, whatever the list holds', () => {
    const state = createProxyRotationState();
    for (let i = 0; i < 5; i++) expect(selectProxy(list, 'off', state, `host:${i}.example`)).toBeNull();
    expect(state.index).toBe(0);
    expect(state.pinned).toBeUndefined();
  });

  describe('per-request', () => {
    it('is identical to the pre-1690 getNextProxy round-robin, including localhost = direct', () => {
      const mixed = ['http://p1:8080', 'localhost', '', 'p4:3128'];
      const legacy = legacyPicker(mixed);
      const state = createProxyRotationState();
      const actual = Array.from({ length: 13 }, (_, i) => selectProxy(mixed, 'per-request', state, `host:${i % 3}.example`));
      const expected = Array.from({ length: 13 }, () => legacy());
      expect(actual).toEqual(expected);
      expect(actual.slice(0, 5)).toEqual(['http://p1:8080', null, null, 'p4:3128', 'http://p1:8080']);
      expect(state.index).toBe(13);
    });

    it('ignores the bucket key and starts at entry 0 for every new state (per client)', () => {
      const a = createProxyRotationState();
      const b = createProxyRotationState();
      expect(selectProxy(list, 'per-request', a, 'host:x')).toBe('http://p1:8080');
      expect(selectProxy(list, 'per-request', a, 'host:x')).toBe('socks5://p2:1080');
      expect(selectProxy(list, 'per-request', b, 'host:y')).toBe('http://p1:8080');
    });

    it('recovers from a corrupted index', () => {
      const state = { index: Number.NaN };
      expect(selectProxy(list, 'per-request', state, 'k')).toBe('http://p1:8080');
      expect(state.index).toBe(1);
    });
  });

  describe('per-scrape', () => {
    beforeEach(() => resetProxyScrapeSeed(0));

    it('pins the first pick for the life of the state', () => {
      const state = createProxyRotationState();
      const first = selectProxy(list, 'per-scrape', state, 'host:a.example');
      expect(first).toBe('http://p1:8080');
      for (let i = 0; i < 10; i++) expect(selectProxy(list, 'per-scrape', state, `host:${i}.example`)).toBe(first);
      expect(state.pinned).toBe(first);
      expect(state.index).toBe(0); // the seeded pick does not move the per-request cursor
    });

    it('successive states (clients / scrapes) start at successive entries, so the list is used evenly', () => {
      const picks = Array.from({ length: 6 }, () => selectProxy(list, 'per-scrape', createProxyRotationState(), 'k'));
      expect(picks).toEqual([...list, ...list]);
    });

    it('the seed does not affect per-request rotation, which still starts at entry 0 (pre-1690)', () => {
      createProxyRotationState();
      const state = createProxyRotationState();
      expect(state.scrapeSeed).toBe(1);
      expect(selectProxy(list, 'per-request', state, 'k')).toBe('http://p1:8080');
    });

    it('picks from the current index, and a pinned localhost stays direct', () => {
      const state = { index: 1 };
      expect(selectProxy(['p1', 'localhost'], 'per-scrape', state, 'k')).toBeNull();
      expect(selectProxy(['p1', 'localhost'], 'per-scrape', state, 'k')).toBeNull();
      expect(state).toEqual({ index: 2, pinned: null });
    });

    it('a new state (a new client / scrape) pins independently', () => {
      const one = createProxyRotationState();
      const two = { index: 2 };
      expect(selectProxy(list, 'per-scrape', one, 'k')).toBe('http://p1:8080');
      expect(selectProxy(list, 'per-scrape', two, 'k')).toBe('p3:3128');
    });
  });

  describe('per-host', () => {
    it('maps a bucket to proxies[fnv1a32(bucket) % n], stable across states and calls', () => {
      const key = 'domain:softy.pro';
      const expected = list[fnv1a32(key) % list.length];
      const a = createProxyRotationState();
      const b = createProxyRotationState();
      for (let i = 0; i < 5; i++) {
        expect(selectProxy(list, 'per-host', a, key)).toBe(expected);
        expect(selectProxy(list, 'per-host', b, key)).toBe(expected);
      }
      expect(a.index).toBe(0);
      expect(a.pinned).toBeUndefined();
    });

    it('spreads different buckets across the whole list', () => {
      const seen = new Set<string | null>();
      const state = createProxyRotationState();
      for (let i = 0; i < 200; i++) seen.add(selectProxy(list, 'per-host', state, `host:tenant${i}.example`));
      expect(seen).toEqual(new Set(list));
    });

    it('a bucket that hashes to localhost is direct', () => {
      const withLocal = ['localhost', 'p2'];
      const state = createProxyRotationState();
      const key = Array.from({ length: 50 }, (_, i) => `host:${i}`).find((k) => fnv1a32(k) % 2 === 0)!;
      expect(selectProxy(withLocal, 'per-host', state, key)).toBeNull();
    });

    it('is the fallback for an unknown rotation value', () => {
      const state = createProxyRotationState();
      const key = 'host:a.example';
      expect(selectProxy(list, 'bogus' as ProxyRotation, state, key)).toBe(selectProxy(list, 'per-host', state, key));
    });
  });
});

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes UTF-8 bytes and always returns an unsigned 32-bit integer', () => {
    for (const s of ['host:bücher.example', 'host:例え.jp', 'x'.repeat(1000)]) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
    expect(fnv1a32('host:bücher.example')).not.toBe(fnv1a32('host:bucher.example'));
  });
});
