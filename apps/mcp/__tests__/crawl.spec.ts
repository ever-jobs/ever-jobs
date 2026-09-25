import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { CRAWL_POLICY_DTO_VALUES, CrawlPolicyDto } from '@ever-jobs/models';

const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ post: mockPost, get: jest.fn() })) },
}));

import {
  CRAWL_POLICY_INPUT_SCHEMA,
  MCP_CRAWL_ENUMS,
  normalizeMcpCrawl,
  searchJobs,
} from '../src/tools';

/**
 * Spec 1690 §5.2 — the MCP `search_jobs` tool takes an optional camelCase
 * `crawl` object and forwards it to the API unchanged. The MCP package cannot
 * import `@ever-jobs/models`, so its schema is a copy; these tests pin the copy
 * to the DTO.
 */

/** Property names that carry class-validator rules on `CrawlPolicyDto`. */
function crawlDtoFields(): string[] {
  const metas = getMetadataStorage().getTargetValidationMetadatas(CrawlPolicyDto, '', true, false);
  return [...new Set(metas.map((m) => m.propertyName))].sort();
}

describe('MCP crawl schema (Spec 1690)', () => {
  it('enum values match CRAWL_POLICY_DTO_VALUES', () => {
    expect(MCP_CRAWL_ENUMS).toEqual(CRAWL_POLICY_DTO_VALUES);
  });

  it('exposes exactly the CrawlPolicyDto fields', () => {
    expect(Object.keys(CRAWL_POLICY_INPUT_SCHEMA.properties).sort()).toEqual(crawlDtoFields());
  });

  it('declares each enum field with its allowed values', () => {
    const props = CRAWL_POLICY_INPUT_SCHEMA.properties as Record<string, { enum?: readonly string[] }>;
    for (const [field, values] of Object.entries(MCP_CRAWL_ENUMS)) {
      expect(props[field].enum).toEqual(values);
    }
  });

  it('is an object schema that rejects unknown keys', () => {
    expect(CRAWL_POLICY_INPUT_SCHEMA.type).toBe('object');
    expect(CRAWL_POLICY_INPUT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('normalizeMcpCrawl', () => {
  it('treats absent / empty values as no crawl', () => {
    expect(normalizeMcpCrawl(undefined)).toBeUndefined();
    expect(normalizeMcpCrawl(null)).toBeUndefined();
    expect(normalizeMcpCrawl('')).toBeUndefined();
    expect(normalizeMcpCrawl({})).toBeUndefined();
    expect(normalizeMcpCrawl('{}')).toBeUndefined();
  });

  it('accepts an object or a JSON-object string (camelCase keys kept as-is)', () => {
    const crawl = { maxConcurrentPerHost: 1, discovery: 'sitemap' };
    expect(normalizeMcpCrawl(crawl)).toEqual(crawl);
    expect(normalizeMcpCrawl(crawl)).not.toBe(crawl);
    expect(normalizeMcpCrawl(JSON.stringify(crawl))).toEqual(crawl);
  });

  it('throws on anything else, so the tool reports the mistake', () => {
    expect(() => normalizeMcpCrawl('{nope')).toThrow('crawl must be an object');
    expect(() => normalizeMcpCrawl('[1]')).toThrow('crawl must be an object');
    expect(() => normalizeMcpCrawl(['x'])).toThrow('crawl must be an object');
    expect(() => normalizeMcpCrawl(5)).toThrow('crawl must be an object');
  });
});

describe('searchJobs → POST /api/jobs/search (Spec 1690)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { jobs: [] } });
  });

  it('forwards crawl under the camelCase key "crawl", unchanged', async () => {
    const crawl = { maxConcurrentPerHost: 1, minIntervalMs: 1000, proxyRotation: 'off' };
    await searchJobs({ query: 'engineer', source: 'softy', company: 'acme', crawl });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe('/api/jobs/search');
    expect(body.crawl).toEqual(crawl);
  });

  it('adds no crawl key when none was given', async () => {
    await searchJobs({ query: 'engineer', source: 'softy', company: 'acme', limit: 5 });
    const body = mockPost.mock.calls[0][1];
    expect('crawl' in body).toBe(false);
  });

  it('posts the camelCase keys ScraperInputDto declares (§4.9), never snake_case', async () => {
    await searchJobs({ query: 'engineer', location: 'Paris', source: 'softy', company: 'acme', limit: 5 });
    const body = mockPost.mock.calls[0][1];
    expect(body).toEqual({
      searchTerm: 'engineer',
      location: 'Paris',
      siteType: ['softy'],
      companySlug: 'acme',
      resultsWanted: 5,
    });
    for (const key of ['search_term', 'site_type', 'company_slug', 'results_wanted']) expect(key in body).toBe(false);
  });

  it('omits siteType/companySlug when not given (an empty search stays empty, not undefined keys)', async () => {
    await searchJobs({ query: 'engineer' });
    expect(Object.keys(mockPost.mock.calls[0][1]).sort()).toEqual(['location', 'resultsWanted', 'searchTerm']);
  });

  it('the posted body survives the API ValidationPipe({ whitelist: true }) — term, source and limit arrive', async () => {
    const { ValidationPipe } = await import('@nestjs/common');
    const { ScraperInputDto } = await import('@ever-jobs/models');
    await searchJobs({ query: 'engineer', source: 'softy', company: 'acme', limit: 7, crawl: { maxConcurrentPerHost: 1 } });
    const body = mockPost.mock.calls[0][1];

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const dto = (await pipe.transform(body, { type: 'body', metatype: ScraperInputDto })) as InstanceType<typeof ScraperInputDto>;

    expect(dto.searchTerm).toBe('engineer');
    expect(dto.siteType).toEqual(['softy']);
    expect(dto.companySlug).toBe('acme');
    expect(dto.resultsWanted).toBe(7);
    expect(dto.crawl?.maxConcurrentPerHost).toBe(1);
  });
});
