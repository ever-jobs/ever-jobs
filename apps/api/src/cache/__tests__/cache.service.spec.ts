import 'reflect-metadata';
import { CacheService } from '../cache.service';

// Mock CACHE_MANAGER that behaves like an in-memory store
function createMockCacheManager() {
  const store = new Map<string, any>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: any) => { store.set(key, value); }),
    // cache-manager v6+ (Keyv-based) renamed `reset()` → `clear()`, and
    // `CacheService.clear()` calls `clear()`. This mock only defined `reset()`,
    // so the real call hit `undefined`, threw, and was swallowed by the
    // service's try/catch — making "should clear all entries" fail on a clean
    // checkout and, worse, implying a production bug that does not exist.
    // `Cache.clear()` is present in `cache-manager@7`'s type surface
    // (`dist/index.d.cts`); `reset?()` is the optional legacy alias.
    clear: jest.fn(async () => { store.clear(); }),
    reset: jest.fn(async () => { store.clear(); }),
    del: jest.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

function createCacheService(
  opts: { enabled?: boolean; expirySec?: number; redisUrl?: string | null } = {},
) {
  const config = {
    get: jest.fn((key: string, fallback?: any) => {
      if (key === 'cache.enabled') return opts.enabled ?? true;
      if (key === 'cache.expirySec') return opts.expirySec ?? 3600;
      if (key === 'cache.redisUrl') return opts.redisUrl ?? null;
      return fallback;
    }),
  };
  const metrics = {
    cacheHitsTotal: { inc: jest.fn() },
    cacheMissesTotal: { inc: jest.fn() },
  };
  const cacheManager = createMockCacheManager();
  return { 
    service: new CacheService(config as any, metrics as any, cacheManager as any), 
    cacheManager,
    metrics,
  };
}

describe('CacheService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when enabled', () => {
    let cache: CacheService;
    let mockCm: ReturnType<typeof createMockCacheManager>;

    beforeEach(() => {
      const { service, cacheManager } = createCacheService({ enabled: true, expirySec: 60 });
      cache = service;
      mockCm = cacheManager;
    });

    it('should store and retrieve values', async () => {
      const params = { searchTerm: 'node', endpoint: 'search' };
      await cache.set(params, [{ id: 1 }, { id: 2 }]);

      const result = await cache.get(params);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get({ searchTerm: 'unknown' });
      expect(result).toBeNull();
    });

    it('should generate same key for same params regardless of order', async () => {
      await cache.set({ a: 1, b: 2 }, 'value');
      const result = await cache.get({ b: 2, a: 1 });
      expect(result).toBe('value');
    });

    it('should ignore null/undefined params in key generation', async () => {
      await cache.set({ a: 1, b: null, c: undefined }, 'value');
      const result = await cache.get({ a: 1 });
      expect(result).toBe('value');
    });

    it('should clear all entries', async () => {
      await cache.set({ a: 1 }, 'v1');
      await cache.set({ b: 2 }, 'v2');
      await cache.clear();

      expect(await cache.get({ a: 1 })).toBeNull();
      expect(await cache.get({ b: 2 })).toBeNull();
    });

    it('should call cacheManager.set with TTL in milliseconds', async () => {
      await cache.set({ key: 'test' }, 'data');
      expect(mockCm.set).toHaveBeenCalledWith(
        expect.any(String),
        'data',
        60_000, // 60 sec * 1000
      );
    });

    it('should report store type as memory when no Redis URL', () => {
      expect(cache.getStoreType()).toBe('memory');
    });
  });

  describe('when enabled with Redis URL', () => {
    it('should report store type as redis', () => {
      const { service } = createCacheService({ enabled: true, redisUrl: 'redis://localhost:6379' });
      expect(service.getStoreType()).toBe('redis');
    });
  });

  describe('when disabled', () => {
    let cache: CacheService;

    beforeEach(() => {
      const { service } = createCacheService({ enabled: false });
      cache = service;
    });

    it('should always return null on get', async () => {
      await cache.set({ a: 1 }, 'value');
      expect(await cache.get({ a: 1 })).toBeNull();
    });
  });

  describe('error resilience', () => {
    it('should handle cache manager errors gracefully on get', async () => {
      const config = {
        get: jest.fn((key: string) => {
          if (key === 'cache.enabled') return true;
          if (key === 'cache.expirySec') return 3600;
          if (key === 'cache.redisUrl') return null;
          return undefined;
        }),
      };
      const metrics = {
        cacheHitsTotal: { inc: jest.fn() },
        cacheMissesTotal: { inc: jest.fn() },
      };
      const brokenCm = {
        get: jest.fn(async () => { throw new Error('Redis connection lost'); }),
        set: jest.fn(async () => { throw new Error('Redis connection lost'); }),
        reset: jest.fn(async () => { throw new Error('Redis connection lost'); }),
      };
      const service = new CacheService(config as any, metrics as any, brokenCm as any);

      // Should not throw — returns null gracefully
      const result = await service.get({ a: 1 });
      expect(result).toBeNull();

      // Should not throw on set either
      await expect(service.set({ a: 1 }, 'val')).resolves.not.toThrow();
    });
  });
});
