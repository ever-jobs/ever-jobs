import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { CrawlPolicyDto, JobPostDto, Site } from '@ever-jobs/models';
import { JobsResolver, toCrawlPolicyDto } from '../jobs.resolver';
import { CrawlPolicyGqlInput, SearchJobsInput } from '../gql-types';

/**
 * Spec 1690 §5.2 — GraphQL `SearchJobsInput.crawl`: mapped into the service
 * DTO by the resolver, validated with the same rules as the REST `crawl`, and
 * kept alive under the global `ValidationPipe({ whitelist: true })`.
 */

function createResolver() {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue([] as JobPostDto[]) };
  const cacheService = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const aggregator = {
    aggregateRaw: jest.fn(async (rawJobs: JobPostDto[]) => ({
      jobs: rawJobs,
      rawCount: rawJobs.length,
      outputCount: rawJobs.length,
      deduped: false,
      dedupMetrics: undefined,
    })),
  };
  const configService = { get: (_key: string, def?: unknown) => def };
  const resolver = new JobsResolver(jobsService as any, aggregator as any, cacheService as any, configService as any);
  return { resolver, jobsService, cacheService };
}

function crawlInput(fields: Partial<Record<keyof CrawlPolicyGqlInput, unknown>>): CrawlPolicyGqlInput {
  return Object.assign(new CrawlPolicyGqlInput(), fields);
}

describe('toCrawlPolicyDto (Spec 1690)', () => {
  it('returns undefined for no crawl, an empty crawl, or one with only nulls', () => {
    expect(toCrawlPolicyDto(undefined)).toBeUndefined();
    expect(toCrawlPolicyDto(null)).toBeUndefined();
    expect(toCrawlPolicyDto(crawlInput({}))).toBeUndefined();
    expect(toCrawlPolicyDto(crawlInput({ retries: null, discovery: null }))).toBeUndefined();
  });

  it('copies set fields into a CrawlPolicyDto and drops GraphQL nulls', () => {
    const dto = toCrawlPolicyDto(
      crawlInput({ maxConcurrentPerHost: 1, minIntervalMs: 1000, retryStatuses: [429, 503], robotsTxt: null }),
    );
    expect(dto).toBeInstanceOf(CrawlPolicyDto);
    expect({ ...dto }).toEqual({ maxConcurrentPerHost: 1, minIntervalMs: 1000, retryStatuses: [429, 503] });
  });

  it('copies arrays (the DTO never aliases the GraphQL input)', () => {
    const statuses = [429];
    const dto = toCrawlPolicyDto(crawlInput({ retryStatuses: statuses }))!;
    expect(dto.retryStatuses).toEqual([429]);
    expect(dto.retryStatuses).not.toBe(statuses);
  });
});

describe('JobsResolver.searchJobs — crawl mapping (Spec 1690)', () => {
  it('forwards input.crawl to JobsService as ScraperInputDto.crawl', async () => {
    const { resolver, jobsService } = createResolver();
    const input = Object.assign(new SearchJobsInput(), {
      searchTerm: 'engineer',
      siteType: [Site.SOFTY],
      crawl: crawlInput({ discovery: 'sitemap', maxConcurrentPerHost: 1, userAgentMode: 'strict', retries: null }),
    });

    await resolver.searchJobs(input);

    const passed = jobsService.searchJobs.mock.calls[0][0];
    expect(passed.searchTerm).toBe('engineer');
    expect(passed.crawl).toBeInstanceOf(CrawlPolicyDto);
    expect({ ...passed.crawl }).toEqual({ discovery: 'sitemap', maxConcurrentPerHost: 1, userAgentMode: 'strict' });
  });

  it('does not add a crawl key when the caller sent none (the pre-1690 DTO shape is unchanged)', async () => {
    const { resolver, jobsService } = createResolver();
    await resolver.searchJobs(Object.assign(new SearchJobsInput(), { searchTerm: 'engineer' }));
    expect('crawl' in jobsService.searchJobs.mock.calls[0][0]).toBe(false);
  });

  it('includes crawl in the cache key, so a different crawl policy is a different cache entry', async () => {
    const { resolver, cacheService } = createResolver();
    await resolver.searchJobs(
      Object.assign(new SearchJobsInput(), { searchTerm: 'engineer', crawl: crawlInput({ discovery: 'listing' }) }),
    );
    expect(cacheService.get.mock.calls[0][0].crawl).toMatchObject({ discovery: 'listing' });
  });
});

describe('GraphQL schema (Spec 1690)', () => {
  it('builds with CrawlPolicyInput and SearchJobsInput.crawl, all fields nullable', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GraphQLSchemaBuilderModule] }).compile();
    const schema = await moduleRef.get(GraphQLSchemaFactory).create([JobsResolver]);
    const sdl = printSchema(schema);

    expect(sdl).toMatch(/input SearchJobsInput \{[^}]*\n\s+crawl: CrawlPolicyInput\n/);
    const crawlBlock = /input CrawlPolicyInput \{([^}]*)\}/.exec(sdl)?.[1] ?? '';
    for (const field of Object.keys(CRAWL_POLICY_FIELD_TYPES)) {
      expect(crawlBlock).toContain(`${field}: ${CRAWL_POLICY_FIELD_TYPES[field]}\n`);
    }
    // No field is non-null (every knob optional); only list ITEMS are.
    expect(crawlBlock).not.toMatch(/!\s*\n/);
  });
});

/** Expected GraphQL type of every crawl field (`Int` for counts/ms, not `Float`). */
const CRAWL_POLICY_FIELD_TYPES: Record<string, string> = {
  userAgent: 'String',
  userAgentMode: 'String',
  from: 'String',
  stripClientHints: 'Boolean',
  proxyRotation: 'String',
  rateLimitScope: 'String',
  maxConcurrentPerHost: 'Int',
  minIntervalMs: 'Int',
  jitterMs: 'Int',
  maxQueueWaitMs: 'Int',
  adaptiveThrottle: 'Boolean',
  retries: 'Int',
  retryStatuses: '[Int!]',
  retryBackoff: 'String',
  retryBaseDelayMs: 'Int',
  retryMaxDelayMs: 'Int',
  retryJitter: 'Boolean',
  retryOnNetworkError: 'Boolean',
  respectRetryAfter: 'Boolean',
  maxRetryAfterMs: 'Int',
  retryAfterOverMax: 'String',
  throttleRetryDelayMs: 'Int',
  robotsTxt: 'String',
  blockPrivateNetworks: 'Boolean',
  discovery: 'String',
};

describe('SearchJobsInput under the global ValidationPipe (Spec 1690)', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const args = { type: 'body' as const, metatype: SearchJobsInput };

  it('keeps every search field and the nested crawl (an undecorated class would arrive empty)', async () => {
    const out = (await pipe.transform(
      {
        searchTerm: 'engineer',
        location: 'Paris',
        resultsWanted: 5,
        siteType: [Site.SOFTY],
        companySlug: 'acme',
        dedup: false,
        crawl: { discovery: 'sitemap', maxConcurrentPerHost: 1, retryStatuses: [429], notAKnob: 1 },
      },
      args,
    )) as SearchJobsInput;

    expect(out).toBeInstanceOf(SearchJobsInput);
    expect(out).toMatchObject({
      searchTerm: 'engineer',
      location: 'Paris',
      resultsWanted: 5,
      siteType: [Site.SOFTY],
      companySlug: 'acme',
      dedup: false,
    });
    expect(out.crawl).toBeInstanceOf(CrawlPolicyGqlInput);
    expect({ ...out.crawl }).toEqual({ discovery: 'sitemap', maxConcurrentPerHost: 1, retryStatuses: [429] });
  });

  it('applies the CrawlPolicyDto rules to the GraphQL crawl (inherited validators)', async () => {
    await expect(
      pipe.transform({ searchTerm: 'x', crawl: { proxyRotation: 'sideways' } }, args),
    ).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ searchTerm: 'x', crawl: { jitterMs: -1 } }, args)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('accepts GraphQL nulls for crawl fields', async () => {
    const out = (await pipe.transform({ searchTerm: 'x', crawl: { retries: null, discovery: 'auto' } }, args)) as SearchJobsInput;
    expect(toCrawlPolicyDto(out.crawl)).toEqual(Object.assign(new CrawlPolicyDto(), { discovery: 'auto' }));
  });
});
