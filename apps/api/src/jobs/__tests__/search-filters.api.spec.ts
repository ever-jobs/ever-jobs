import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import {
  ExclusionPreset,
  JobPostDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';
import { JobsResolver } from '../jobs.resolver';
import { JobsAggregator } from '../jobs.aggregator';
import { SearchJobsInput } from '../gql-types';
import { searchCacheParams } from '../search-cache-params';

/**
 * Spec 1700 — the REST, GraphQL and cache-key surface of multi-location
 * search and exclusion filters.
 */

function makeJob(id: string, title: string, description?: string): JobPostDto {
  return new JobPostDto({
    id,
    title,
    description,
    companyName: 'Acme',
    jobUrl: `https://example.com/job/${id}`,
    site: Site.LINKEDIN,
  });
}

const JOBS = () => [
  makeJob('1', 'Senior Engineer'),
  makeJob('2', 'Engineer'),
  makeJob('3', 'Analyst', 'Active TS/SCI required.'),
  makeJob('4', 'Designer'),
  makeJob('5', 'Lead Designer'),
];

function createController(opts: { jobs?: JobPostDto[]; realAggregator?: boolean; liveness?: any } = {}) {
  const jobs = opts.jobs ?? JOBS();
  const jobsService = {
    searchJobs: jest.fn().mockResolvedValue(jobs),
    searchJobsWithDiagnostics: jest.fn().mockResolvedValue({ jobs, perSource: [] }),
  };
  const cacheService = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const analyticsService = { analyze: jest.fn().mockReturnValue({ summary: { totalJobs: 0 }, companies: [] }) };
  const aggregator = opts.realAggregator
    ? new JobsAggregator(jobsService as any)
    : {
        aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
          jobs: raw,
          rawCount: raw.length,
          outputCount: raw.length,
          deduped: false,
        })),
      };
  const configService = { get: (_key: string, def?: unknown) => def };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    analyticsService as any,
    cacheService as any,
    configService as any,
    opts.liveness,
  );
  return { controller, jobsService, cacheService, analyticsService, aggregator };
}

async function search(
  controller: JobsController,
  body: Partial<ScraperInputDto>,
  query: { paginate?: string; pageSize?: string; diagnostics?: string; liveness?: string } = {},
): Promise<any> {
  return controller.searchJobs(
    new ScraperInputDto(body),
    undefined,
    query.paginate,
    undefined,
    query.pageSize,
    undefined,
    query.liveness,
    undefined,
    undefined,
    query.diagnostics,
    undefined,
  );
}

describe('searchCacheParams (Spec 1700)', () => {
  it('returns exactly { ...input, ...extra } when no new field is present', () => {
    const input = new ScraperInputDto({ searchTerm: 'node', location: 'Berlin' });
    expect(searchCacheParams(input, { endpoint: 'search' }, 10)).toEqual({ ...input, endpoint: 'search' });
  });

  it('keys permuted and case-different locations identically', () => {
    const a = searchCacheParams(new ScraperInputDto({ locations: ['New York, NY', 'Chicago, IL'] }), {}, 10);
    const b = searchCacheParams(new ScraperInputDto({ locations: ['chicago, il', ' New York,  NY'] }), {}, 10);
    expect(a).toEqual(b);
    expect(a.locations).toEqual(['chicago, il', 'new york, ny']);
    expect(a.location).toBeUndefined();
  });

  it('folds `location` into the list key', () => {
    const a = searchCacheParams(new ScraperInputDto({ location: 'A', locations: ['B'] }), {}, 10);
    const b = searchCacheParams(new ScraperInputDto({ locations: ['b', 'a'] }), {}, 10);
    expect(a).toEqual(b);
  });

  it('keys a single-entry list like a plain location', () => {
    const list = searchCacheParams(new ScraperInputDto({ locations: ['Berlin'] }), {}, 10);
    const plain = searchCacheParams(new ScraperInputDto({ location: 'Berlin' }), {}, 10);
    expect(JSON.stringify(Object.entries(list).filter(([, v]) => v !== undefined).sort())).toBe(
      JSON.stringify(Object.entries(plain).filter(([, v]) => v !== undefined).sort()),
    );
  });

  it('only keys the locations actually searched', () => {
    const many = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const a = searchCacheParams(new ScraperInputDto({ locations: many }), {}, 10);
    const b = searchCacheParams(new ScraperInputDto({ locations: many.slice(0, 10) }), {}, 10);
    expect(a).toEqual(b);
  });

  it('blanks every exclusion field', () => {
    const p = searchCacheParams(
      new ScraperInputDto({
        excludeTitleTerms: ['senior'],
        excludeKeywords: ['polygraph'],
        excludePresets: [ExclusionPreset.SECURITY_CLEARANCE],
      }),
      {},
      10,
    );
    expect(p.excludeTitleTerms).toBeUndefined();
    expect(p.excludeKeywords).toBeUndefined();
    expect(p.excludePresets).toBeUndefined();
  });
});

describe('JobsController — Spec 1700', () => {
  it('caches a request without new fields under the pre-change params', async () => {
    const { controller, cacheService } = createController();
    await search(controller, { searchTerm: 'node', location: 'Berlin' });
    expect(cacheService.get).toHaveBeenCalledWith({
      ...new ScraperInputDto({ searchTerm: 'node', location: 'Berlin' }),
      endpoint: 'search',
    });
  });

  it('two requests differing only in exclusions share one cache entry', async () => {
    const { controller, cacheService } = createController();
    await search(controller, { searchTerm: 'node' });
    await search(controller, { searchTerm: 'node', excludeTitleTerms: ['senior'] });
    const [first, second] = cacheService.get.mock.calls.map((c) => JSON.stringify(Object.entries(c[0]).filter(([, v]) => v !== undefined)));
    expect(second).toBe(first);
  });

  it('permuted locations share one cache entry', async () => {
    const { controller, cacheService } = createController();
    await search(controller, { locations: ['New York, NY', 'Chicago, IL'] });
    await search(controller, { locations: ['CHICAGO, IL', 'new york, ny'] });
    expect(cacheService.get.mock.calls[1][0]).toEqual(cacheService.get.mock.calls[0][0]);
  });

  it('passes exclusions to the aggregator only when supplied', async () => {
    const { controller, aggregator } = createController();
    await search(controller, { searchTerm: 'node' });
    await search(controller, { searchTerm: 'node', excludeKeywords: ['polygraph'] });
    const calls = (aggregator as any).aggregateRaw.mock.calls;
    expect(calls[0][1]).toEqual({ dedup: true, persist: true });
    expect(calls[1][1]).toEqual({
      dedup: true,
      persist: true,
      exclusions: { titleTerms: undefined, keywords: ['polygraph'], presets: undefined },
    });
  });

  it('omits exclusion_metrics without exclusion input', async () => {
    const { controller } = createController({ realAggregator: true });
    const res = await search(controller, { searchTerm: 'node' });
    expect(res).not.toHaveProperty('exclusion_metrics');
    expect(res.count).toBe(5);
  });

  it('filters and reports exclusion_metrics, samples only with ?diagnostics', async () => {
    const { controller } = createController({ realAggregator: true });
    const body = { excludeTitleTerms: ['senior', 'lead'], excludePresets: [ExclusionPreset.SECURITY_CLEARANCE] };

    const plain = await search(controller, body);
    expect(plain.jobs.map((j: JobPostDto) => j.id)).toEqual(['2', '4']);
    expect(plain.count).toBe(2);
    expect(plain.raw_count).toBe(5);
    expect(plain.exclusion_metrics).toEqual({
      excluded_count: 3,
      excluded_raw_count: 3,
      by_term: [
        { term: 'senior', source: 'title_terms', count: 1 },
        { term: 'ts sci', source: 'preset:security_clearance', count: 1 },
        { term: 'lead', source: 'title_terms', count: 1 },
      ],
      ignored_terms: [],
    });

    const withDiagnostics = await search(controller, body, { diagnostics: 'true' });
    expect(withDiagnostics.exclusion_metrics.samples).toEqual([
      { id: '1', site: Site.LINKEDIN, title: 'Senior Engineer', term: 'senior', source: 'title_terms', field: 'title' },
      { id: '3', site: Site.LINKEDIN, title: 'Analyst', term: 'ts sci', source: 'preset:security_clearance', field: 'description' },
      { id: '5', site: Site.LINKEDIN, title: 'Lead Designer', term: 'lead', source: 'title_terms', field: 'title' },
    ]);
  });

  it('reports metrics for a supplied-but-empty list without removing anything', async () => {
    const { controller } = createController({ realAggregator: true });
    const res = await search(controller, { excludeTitleTerms: [] });
    expect(res.count).toBe(5);
    expect(res.exclusion_metrics).toMatchObject({ excluded_count: 0, excluded_raw_count: 0 });
  });

  it('computes count and total_pages after exclusion', async () => {
    const { controller } = createController({ realAggregator: true });
    const res = await search(controller, { excludeTitleTerms: ['designer'] }, { paginate: 'true', pageSize: '2' });
    expect(res.count).toBe(3);
    expect(res.total_pages).toBe(2);
    expect(res.exclusion_metrics.excluded_count).toBe(2);
  });

  it('never liveness-probes an excluded job', async () => {
    const checkBatch = jest.fn(async (urls: string[]) => urls.map(() => null));
    const { controller } = createController({ realAggregator: true, liveness: { checkBatch } });
    await search(controller, { excludeTitleTerms: ['senior'] }, { liveness: 'true' });
    expect(checkBatch).toHaveBeenCalledTimes(1);
    expect(checkBatch.mock.calls[0][0]).not.toContain('https://example.com/job/1');
    expect(checkBatch.mock.calls[0][0]).toHaveLength(4);
  });

  it('/analyze analyses the filtered set', async () => {
    const { controller, analyticsService } = createController();
    await controller.analyzeJobs(new ScraperInputDto({ excludeTitleTerms: ['designer'] }));
    expect(analyticsService.analyze.mock.calls[0][0].map((j: JobPostDto) => j.id)).toEqual(['1', '2', '3']);
  });

  it('/analyze without exclusions analyses the raw set', async () => {
    const jobs = JOBS();
    const { controller, analyticsService } = createController({ jobs });
    await controller.analyzeJobs(new ScraperInputDto({ searchTerm: 'x' }));
    expect(analyticsService.analyze).toHaveBeenCalledWith(jobs);
  });

  describe('body validation through the global ValidationPipe', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
    const meta = { type: 'body' as const, metatype: ScraperInputDto, data: '' };

    it('keeps the new fields', async () => {
      const out = await pipe.transform(
        {
          locations: ['A', 'B'],
          excludeTitleTerms: ['senior'],
          excludeKeywords: ['polygraph'],
          excludePresets: ['security_clearance'],
        },
        meta,
      );
      expect(out).toMatchObject({
        locations: ['A', 'B'],
        excludeTitleTerms: ['senior'],
        excludeKeywords: ['polygraph'],
        excludePresets: ['security_clearance'],
      });
    });

    it.each([
      ['26 locations', { locations: Array.from({ length: 26 }, (_, i) => `C${i}`) }],
      ['51 title terms', { excludeTitleTerms: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
      ['a 101-char keyword', { excludeKeywords: ['x'.repeat(101)] }],
      ['a numeric term', { excludeTitleTerms: [3] }],
      ['an unknown preset', { excludePresets: ['nope'] }],
    ])('rejects %s with a 400', async (_label, body) => {
      await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('JobsResolver — Spec 1700', () => {
  function createResolver(jobs = JOBS(), realAggregator = false) {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
    const cacheService = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const aggregator = realAggregator
      ? new JobsAggregator(jobsService as any)
      : {
          aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
            jobs: raw,
            rawCount: raw.length,
            outputCount: raw.length,
            deduped: false,
          })),
        };
    const resolver = new JobsResolver(
      jobsService as any,
      aggregator as any,
      cacheService as any,
      { get: (_k: string, def?: unknown) => def } as any,
    );
    return { resolver, jobsService, cacheService, aggregator };
  }

  function input(fields: Partial<SearchJobsInput>): SearchJobsInput {
    return Object.assign(new SearchJobsInput(), { searchTerm: 'node' }, fields);
  }

  it('forwards locations to the service', async () => {
    const { resolver, jobsService } = createResolver();
    await resolver.searchJobs(input({ locations: ['New York, NY', 'Chicago, IL'] }));
    expect(jobsService.searchJobs.mock.calls[0][0].locations).toEqual(['New York, NY', 'Chicago, IL']);
  });

  it('does not add a locations key when none was sent', async () => {
    const { resolver, jobsService } = createResolver();
    await resolver.searchJobs(input({ location: 'Berlin' }));
    expect('locations' in jobsService.searchJobs.mock.calls[0][0]).toBe(false);
  });

  it('normalises the cache key and keeps exclusions out of it', async () => {
    const { resolver, cacheService } = createResolver();
    await resolver.searchJobs(input({ locations: ['B', 'a'] }));
    await resolver.searchJobs(input({ locations: ['A', 'b'], excludeTitleTerms: ['senior'] }));
    const [first, second] = cacheService.get.mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
    expect(first.endpoint).toBe('graphql-search-v2');
    expect(first.locations).toEqual(['a', 'b']);
  });

  it('keeps the pre-change cache params for a plain query', async () => {
    const { resolver, cacheService } = createResolver();
    const plain = input({ location: 'Berlin' });
    await resolver.searchJobs(plain);
    expect(cacheService.get).toHaveBeenCalledWith({ ...plain, endpoint: 'graphql-search-v2', dedup: undefined });
  });

  it('filters and returns exclusionMetrics', async () => {
    const { resolver } = createResolver(JOBS(), true);
    const out = await resolver.searchJobs(
      input({ excludeTitleTerms: ['senior'], excludePresets: [ExclusionPreset.SECURITY_CLEARANCE] }),
    );
    expect(out.count).toBe(3);
    expect(out.rawCount).toBe(5);
    expect(out.exclusionMetrics).toMatchObject({ excludedCount: 2, excludedRawCount: 2 });
  });

  it('returns no exclusionMetrics without exclusion input', async () => {
    const { resolver } = createResolver(JOBS(), true);
    const out = await resolver.searchJobs(input({}));
    expect(out).not.toHaveProperty('exclusionMetrics');
  });
});

describe('GraphQL schema — Spec 1700 fields', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GraphQLSchemaBuilderModule] }).compile();
    await moduleRef.init();
    schema = await moduleRef.get(GraphQLSchemaFactory).create([JobsResolver]);
  });

  it('SearchJobsInput exposes locations and the exclusion fields', () => {
    const type = schema.getType('SearchJobsInput') as unknown as { getFields(): Record<string, { type: unknown }> };
    const fields = Object.fromEntries(Object.entries(type.getFields()).map(([k, f]) => [k, String(f.type)]));
    expect(fields.locations).toBe('[String!]');
    expect(fields.excludeTitleTerms).toBe('[String!]');
    expect(fields.excludeKeywords).toBe('[String!]');
    expect(fields.excludePresets).toBe('[ExclusionPreset!]');
  });

  it('SearchJobsResult.exclusionMetrics is nullable', () => {
    const type = schema.getType('SearchJobsResult') as GraphQLObjectType;
    expect(String(type.getFields().exclusionMetrics.type)).toBe('ExclusionMetricsGql');
    const metrics = schema.getType('ExclusionMetricsGql') as GraphQLObjectType;
    expect(Object.keys(metrics.getFields())).toEqual(['excludedCount', 'excludedRawCount', 'byTerm', 'ignoredTerms']);
  });

  describe('under the global ValidationPipe', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
    const meta = { type: 'body' as const, metatype: SearchJobsInput, data: 'input' };

    it('keeps the new fields', async () => {
      const body = {
        searchTerm: 'x',
        locations: ['A', 'B'],
        excludeTitleTerms: ['senior'],
        excludeKeywords: ['polygraph'],
        excludePresets: ['security_clearance'],
      };
      const out = await pipe.transform({ ...body }, meta);
      expect({ ...out }).toEqual(body);
    });

    it('accepts explicit nulls', async () => {
      const out = await pipe.transform({ searchTerm: 'x', locations: null, excludePresets: null }, meta);
      expect(out.searchTerm).toBe('x');
    });

    it('rejects 26 locations and an unknown preset', async () => {
      await expect(
        pipe.transform({ searchTerm: 'x', locations: Array.from({ length: 26 }, (_, i) => `C${i}`) }, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ searchTerm: 'x', excludePresets: ['nope'] }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
