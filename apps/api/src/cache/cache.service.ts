import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { MetricsService } from '../metrics/metrics.service';
import * as crypto from 'crypto';

/**
 * Application-level cache service wrapping the NestJS CacheManager.
 *
 * Provides a deterministic key generation from search parameters
 * and respects the enabled/disabled flag from configuration.
 *
 * Backing store is configured by AppCacheModule:
 *   - Redis when REDIS_URL is set
 *   - In-memory otherwise
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly enabled: boolean;
  private readonly ttlMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    this.enabled = this.config.get<boolean>('cache.enabled', false);
    this.ttlMs = this.config.get<number>('cache.expirySec', 3600) * 1000;

    const redisUrl = this.config.get<string>('cache.redisUrl');
    if (this.enabled) {
      this.logger.log(
        `Cache enabled — TTL ${this.ttlMs / 1000}s, store: ${redisUrl ? 'Redis' : 'in-memory'}`,
      );
    } else {
      this.logger.log('Cache disabled');
    }
  }

  /** Generate a deterministic cache key from search parameters. */
  private generateKey(params: Record<string, any>): string {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(params).sort()) {
      if (params[key] !== undefined && params[key] !== null) {
        sorted[key] = params[key];
      }
    }
    const raw = JSON.stringify(sorted);
    return `everjobs:${crypto.createHash('md5').update(raw).digest('hex')}`;
  }

  /** Retrieve cached data, or null if missing / expired / disabled. */
  async get<T>(params: Record<string, any>): Promise<T | null> {
    if (!this.enabled) return null;

    try {
      const key = this.generateKey(params);
      const result = await this.cacheManager.get<T>(key);
      if (result !== undefined && result !== null) {
        this.logger.debug(`Cache hit for key ${key.substring(0, 16)}...`);
        this.metrics.cacheHitsTotal.inc();
        return result;
      }
      this.metrics.cacheMissesTotal.inc();
      return null;
    } catch (err: any) {
      this.logger.warn(`Cache get error: ${err.message}`);
      return null;
    }
  }

  /** Store data in cache. */
  async set<T>(params: Record<string, any>, data: T): Promise<void> {
    if (!this.enabled) return;

    try {
      const key = this.generateKey(params);
      await this.cacheManager.set(key, data, this.ttlMs);
    } catch (err: any) {
      this.logger.warn(`Cache set error: ${err.message}`);
    }
  }

  /** Clear all cached data. */
  async clear(): Promise<void> {
    try {
      // cache-manager v6+ (Keyv-based) replaced `reset()` with `clear()`.
      await this.cacheManager.clear();
    } catch (err: any) {
      this.logger.warn(`Cache clear error: ${err.message}`);
    }
  }

  /** Returns the backing store type for logging/monitoring. */
  getStoreType(): 'redis' | 'memory' {
    return this.config.get<string>('cache.redisUrl') ? 'redis' : 'memory';
  }
}
