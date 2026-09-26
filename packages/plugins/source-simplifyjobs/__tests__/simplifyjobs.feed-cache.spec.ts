import { FeedCache, FeedFetchResult, headerValue, parseMaxAgeMs } from '../src/simplifyjobs.feed-cache';

const OPTIONS = {
  defaultTtlMs: 300_000,
  minTtlMs: 60_000,
  maxTtlMs: 1_800_000,
  staleMaxMs: 6 * 3_600_000,
  errorBackoffMs: 60_000,
  maxEntries: 2,
};

function setup() {
  let now = 1_000_000;
  const cache = new FeedCache<string[]>(() => now, OPTIONS);
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const fresh = (value: string[], etag: string | null = '"v1"', maxAgeMs: number | null = null): FeedFetchResult<string[]> => ({
  status: 'fresh',
  value,
  etag,
  maxAgeMs,
});

describe('FeedCache (Spec 1694)', () => {
  it('fetches once, then serves the copy with no request inside the TTL', async () => {
    const { cache, advance } = setup();
    const fetcher = jest.fn(async () => fresh(['a']));
    expect(await cache.get('k', fetcher)).toMatchObject({ value: ['a'], source: 'fetched' });
    advance(299_999);
    expect(await cache.get('k', fetcher)).toMatchObject({ value: ['a'], source: 'cache', ageMs: 299_999 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(null);
  });

  it('revalidates with the ETag after the TTL; a 304 keeps the rows and restarts the TTL', async () => {
    const { cache, advance } = setup();
    const value = ['a'];
    await cache.get('k', async () => fresh(value, '"v1"'));
    advance(300_000);
    const revalidate = jest.fn(async (): Promise<FeedFetchResult<string[]>> => ({ status: 'not-modified', maxAgeMs: null }));
    const read = await cache.get('k', revalidate);
    expect(revalidate).toHaveBeenCalledWith('"v1"');
    expect(read.source).toBe('revalidated');
    expect(read.value).toBe(value);
    advance(299_000);
    expect((await cache.get('k', revalidate)).source).toBe('cache');
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('replaces the rows and the ETag on a new 200', async () => {
    const { cache, advance } = setup();
    await cache.get('k', async () => fresh(['old'], '"v1"'));
    advance(300_000);
    expect((await cache.get('k', async () => fresh(['new'], '"v2"'))).value).toEqual(['new']);
    advance(300_000);
    const fetcher = jest.fn(async (): Promise<FeedFetchResult<string[]>> => ({ status: 'not-modified', maxAgeMs: null }));
    await cache.get('k', fetcher);
    expect(fetcher).toHaveBeenCalledWith('"v2"');
  });

  it('honours max-age and clamps it to [1 min, 30 min]', async () => {
    const { cache, advance } = setup();
    await cache.get('long', async () => fresh(['x'], null, 900_000));
    advance(899_000);
    expect((await cache.get('long', async () => fresh(['y']))).source).toBe('cache');

    await cache.get('tiny', async () => fresh(['x'], null, 1_000));
    advance(30_000);
    expect((await cache.get('tiny', async () => fresh(['y']))).source).toBe('cache');

    const huge = setup();
    await huge.cache.get('k', async () => fresh(['x'], null, 86_400_000));
    huge.advance(1_800_000);
    expect((await huge.cache.get('k', async () => fresh(['y']))).value).toEqual(['y']);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const { cache } = setup();
    let release: (v: FeedFetchResult<string[]>) => void = () => undefined;
    const fetcher = jest.fn(() => new Promise<FeedFetchResult<string[]>>((resolve) => (release = resolve)));
    const a = cache.get('k', fetcher);
    const b = cache.get('k', fetcher);
    release(fresh(['a']));
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ra.value).toBe(rb.value);
  });

  it('serves a copy younger than the stale limit after an error, flagged stale', async () => {
    const { cache, advance } = setup();
    await cache.get('k', async () => fresh(['a']));
    advance(3_600_000);
    const boom = new Error('Request failed with status code 503');
    const read = await cache.get('k', async () => {
      throw boom;
    });
    expect(read).toMatchObject({ value: ['a'], source: 'stale', ageMs: 3_600_000, error: boom });
  });

  it('rethrows when the only copy is older than the stale limit, or there is none', async () => {
    const { cache, advance } = setup();
    await expect(
      cache.get('none', async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow('down');
    await cache.get('k', async () => fresh(['a']));
    advance(6 * 3_600_000);
    await expect(
      cache.get('k', async () => {
        throw new Error('still down');
      }),
    ).rejects.toThrow('still down');
  });

  it('makes no new request within the error backoff, then retries', async () => {
    const { cache, advance } = setup();
    await cache.get('k', async () => fresh(['a']));
    advance(300_000);
    const failing = jest.fn(async (): Promise<FeedFetchResult<string[]>> => {
      throw new Error('down');
    });
    expect((await cache.get('k', failing)).source).toBe('stale');
    advance(59_000);
    expect((await cache.get('k', failing)).source).toBe('stale');
    expect(failing).toHaveBeenCalledTimes(1);
    advance(1_000);
    const recovered = jest.fn(async () => fresh(['b']));
    expect((await cache.get('k', recovered)).value).toEqual(['b']);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('rethrows the remembered error within the backoff when nothing is cached', async () => {
    const { cache } = setup();
    const failing = jest.fn(async (): Promise<FeedFetchResult<string[]>> => {
      throw new Error('down');
    });
    await expect(cache.get('k', failing)).rejects.toThrow('down');
    await expect(cache.get('k', failing)).rejects.toThrow('down');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('treats a 304 without a cached copy as an error', async () => {
    const { cache } = setup();
    await expect(cache.get('k', async () => ({ status: 'not-modified', maxAgeMs: null }))).rejects.toThrow(
      /304 Not Modified without a cached copy/,
    );
  });

  it('keeps at most maxEntries keys, dropping the least recently refreshed', async () => {
    const { cache, advance } = setup();
    await cache.get('a', async () => fresh(['a']));
    advance(1);
    await cache.get('b', async () => fresh(['b']));
    advance(1);
    await cache.get('c', async () => fresh(['c']));
    expect(cache.keys().sort()).toEqual(['b', 'c']);
    expect(cache.peek('a')).toBeUndefined();
  });
});

describe('header helpers (Spec 1694)', () => {
  it('reads max-age in ms', () => {
    expect(parseMaxAgeMs('max-age=300')).toBe(300_000);
    expect(parseMaxAgeMs('public, max-age="120", must-revalidate')).toBe(120_000);
    expect(parseMaxAgeMs('s-maxage=10')).toBeNull();
    expect(parseMaxAgeMs('no-cache')).toBeNull();
    expect(parseMaxAgeMs(undefined)).toBeNull();
  });

  it('reads a header case-insensitively from a plain object or a getter', () => {
    expect(headerValue({ ETag: '"abc"' }, 'etag')).toBe('"abc"');
    expect(headerValue({ 'cache-control': ['max-age=1'] }, 'Cache-Control')).toBe('max-age=1');
    expect(headerValue({ get: (n: string) => (n === 'etag' ? '"x"' : undefined) }, 'ETag')).toBe('"x"');
    expect(headerValue(undefined, 'etag')).toBeNull();
    expect(headerValue({}, 'etag')).toBeNull();
  });
});
