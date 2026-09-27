/**
 * Integration — Spec 1690 over real HTTP: the REST `crawl` object through the
 * production `ValidationPipe({ transform, whitelist })`, and the read-only
 * `GET /api/sources/:site/crawl-policy` endpoint.
 *
 * Real: Nest routing, the global validation pipe, `ScraperInputDto` /
 * `CrawlPolicyDto` validation, `SourcesHealthController`, `PluginRegistry` and
 * the crawl-policy resolver. Stubbed: `JobsService` (no scraping) and the
 * cache/aggregator/analytics collaborators of `JobsController`.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CrawlPolicyDto, IScraper, JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';
import { CRAWL_ENV, resetCrawlPolicyEnvCache } from '@ever-jobs/common';
import { PluginRegistry } from '@ever-jobs/plugin';
import { JobsController } from '../../src/jobs/jobs.controller';
import { JobsService } from '../../src/jobs/jobs.service';
import { JobsAggregator } from '../../src/jobs/jobs.aggregator';
import { CacheService } from '../../src/cache/cache.service';
import { SourcesHealthController } from '../../src/jobs/health.controller';

describe('Integration — crawl policy over HTTP (Spec 1690)', () => {
  let app: INestApplication;
  const searchJobsWithDiagnostics = jest.fn();
  const saved = process.env[CRAWL_ENV.CALLER_OVERRIDES];

  beforeAll(async () => {
    delete process.env[CRAWL_ENV.CALLER_OVERRIDES];
    resetCrawlPolicyEnvCache();

    const registry = new PluginRegistry();
    const scraper: IScraper = { scrape: async () => new JobResponseDto([]) };
    registry.register(
      {
        site: Site.SOFTY,
        name: 'Softy',
        category: 'ats',
        isAts: true,
        crawl: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 },
      },
      scraper,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [JobsController, SourcesHealthController],
      providers: [
        { provide: JobsService, useValue: { searchJobsWithDiagnostics } },
        {
          provide: JobsAggregator,
          useValue: { aggregateRaw: async (jobs: unknown[]) => ({ jobs, rawCount: jobs.length, deduped: false }) },
        },
        { provide: AnalyticsService, useValue: {} },
        { provide: CacheService, useValue: { get: async () => null, set: async () => undefined } },
        { provide: ConfigService, useValue: { get: (_k: string, def?: unknown) => def } },
        { provide: PluginRegistry, useValue: registry },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env[CRAWL_ENV.CALLER_OVERRIDES];
    else process.env[CRAWL_ENV.CALLER_OVERRIDES] = saved;
    resetCrawlPolicyEnvCache();
  });

  beforeEach(() => {
    searchJobsWithDiagnostics.mockReset();
    searchJobsWithDiagnostics.mockResolvedValue({ jobs: [], perSource: [] });
  });

  describe('POST /api/jobs/search — crawl', () => {
    it('delivers a validated CrawlPolicyDto (unknown nested keys stripped) to JobsService', async () => {
      await request(app.getHttpServer())
        .post('/api/jobs/search')
        .send({
          searchTerm: 'engineer',
          siteType: ['softy'],
          userAgent: 'AcmeBot/1.0',
          crawl: { maxConcurrentPerHost: 1, discovery: 'sitemap', retryStatuses: [429, 503], notAKnob: true },
        })
        .expect(201);

      expect(searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
      const input = searchJobsWithDiagnostics.mock.calls[0][0] as ScraperInputDto;
      expect(input).toBeInstanceOf(ScraperInputDto);
      expect(input.userAgent).toBe('AcmeBot/1.0');
      expect(input.crawl).toBeInstanceOf(CrawlPolicyDto);
      expect({ ...input.crawl }).toEqual({ maxConcurrentPerHost: 1, discovery: 'sitemap', retryStatuses: [429, 503] });
    });

    it('rejects an invalid crawl with 400 before any scraping', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/jobs/search')
        .send({ searchTerm: 'engineer', crawl: { proxyRotation: 'sideways', minIntervalMs: -1 } })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('proxyRotation');
      expect(searchJobsWithDiagnostics).not.toHaveBeenCalled();
    });

    it('a search without crawl is unchanged', async () => {
      await request(app.getHttpServer()).post('/api/jobs/search').send({ searchTerm: 'engineer' }).expect(201);
      expect((searchJobsWithDiagnostics.mock.calls[0][0] as ScraperInputDto).crawl).toBeUndefined();
    });
  });

  describe('GET /api/sources/:site/crawl-policy', () => {
    it('returns the resolved policy with provenance for a plugin and host', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sources/softy/crawl-policy')
        .query({ host: 'acme.softy.pro' })
        .expect(200);

      expect(res.body).toMatchObject({
        site: 'softy',
        host: 'acme.softy.pro',
        rateLimitScope: 'domain',
        maxConcurrentPerHost: 1,
        minIntervalMs: 1000,
        provenance: { rateLimitScope: 'plugin', maxConcurrentPerHost: 'plugin', userAgent: 'preset' },
        meta: { preset: 'polite', plugin: { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 } },
      });
      expect(Array.isArray(res.body.warnings)).toBe(true);
    });

    it('previews a caller override passed as ?crawl=', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sources/linkedin/crawl-policy')
        .query({ crawl: JSON.stringify({ robotsTxt: 'respect' }) })
        .expect(200);
      expect(res.body.robotsTxt).toBe('respect');
      expect(res.body.provenance.robotsTxt).toBe('caller');
      expect(res.body.meta.caller).toEqual({ rejected: [] });
    });

    it('404s for an unknown site and 400s for a bad host', async () => {
      await request(app.getHttpServer()).get('/api/sources/not-a-source/crawl-policy').expect(404);
      await request(app.getHttpServer())
        .get('/api/sources/softy/crawl-policy')
        .query({ host: 'bad host' })
        .expect(400);
    });

    it('does not shadow GET /api/sources/health', async () => {
      await request(app.getHttpServer()).get('/api/sources/health').expect(200);
    });
  });

  describe('Spec 1714 — new fields and the caller lock', () => {
    it('POST delivers minGapMs / serverErrorCooldownMs and strips a caller callerOverrides (not a DTO field)', async () => {
      await request(app.getHttpServer())
        .post('/api/jobs/search')
        .send({
          searchTerm: 'engineer',
          siteType: ['softy'],
          crawl: { minGapMs: 500, serverErrorCooldownMs: 30000, callerOverrides: 'any' },
        })
        .expect(201);

      const input = searchJobsWithDiagnostics.mock.calls[0][0] as ScraperInputDto;
      expect({ ...input.crawl }).toEqual({ minGapMs: 500, serverErrorCooldownMs: 30000 });
    });

    it('POST rejects a negative or fractional minGapMs / serverErrorCooldownMs with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/jobs/search')
        .send({ searchTerm: 'engineer', crawl: { minGapMs: -1, serverErrorCooldownMs: 1.5 } })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('minGapMs');
      expect(JSON.stringify(res.body)).toContain('serverErrorCooldownMs');
      expect(searchJobsWithDiagnostics).not.toHaveBeenCalled();
    });

    it('GET softy?host=acme.softy.pro shows the builtin *.softy.pro lock and pacing', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sources/softy/crawl-policy')
        .query({ host: 'acme.softy.pro' })
        .expect(200);

      expect(res.body).toMatchObject({
        minGapMs: 500,
        serverErrorCooldownMs: 30000,
        provenance: { minGapMs: 'builtin-host', serverErrorCooldownMs: 'builtin-host' },
        meta: {
          callerOverrides: 'stricter',
          callerOverridesProvenance: 'builtin-host',
          globalCallerOverrides: 'any',
          builtinHostPatterns: ['*.softy.pro'],
          builtinHost: 'acme.softy.pro',
          fleetSize: 1,
        },
      });
      expect(res.body).not.toHaveProperty('callerOverrides');
    });

    it('GET softy?host=…&crawl= refuses less polite caller fields under the lock', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sources/softy/crawl-policy')
        .query({ host: 'acme.softy.pro', crawl: JSON.stringify({ proxyRotation: 'per-request', discovery: 'listing' }) })
        .expect(200);
      expect(res.body.meta.caller.rejected.sort()).toEqual(['discovery', 'proxyRotation']);
      expect(res.body.proxyRotation).toBe('per-host');
    });

    it('GET linkedin: no lock, the global default "any"', async () => {
      const res = await request(app.getHttpServer()).get('/api/sources/linkedin/crawl-policy').expect(200);
      expect(res.body.meta).toMatchObject({
        callerOverrides: 'any',
        callerOverridesProvenance: 'default',
        globalCallerOverrides: 'any',
        builtinHostPatterns: [],
        fleetSize: 1,
      });
      expect(res.body.minGapMs).toBe(0);
      expect(res.body.serverErrorCooldownMs).toBe(0);
    });
  });
});
