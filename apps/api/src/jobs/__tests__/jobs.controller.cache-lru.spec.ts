import 'reflect-metadata';
import { createCache } from 'cache-manager';
import Keyv from 'keyv';
import { CacheableMemory } from 'cacheable';
import { JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { CacheService } from '../../cache/cache.service';
import { JobsController } from '../jobs.controller';
import { COMPLETE_SEARCH } from '../search-completeness';

/**
 * Spec 1721 / FR-19 — the REST search cache under the store every deployed
 * environment runs: the in-memory LRU with `CACHE_MAX_ITEMS=1`.
 *
 * FR-17 wrote the completeness record as a SECOND entry next to the raw set;
 * with one LRU slot that write evicted the raw set, so page 2 of a paginated
 * search re-ran the whole fan-out. The real `CacheService` over the real
 * Keyv/`CacheableMemory` store (built exactly as `AppCacheModule` builds it)
 * is what makes this observable — a Map-backed double never evicts.
 */

function job(i: number): JobPostDto {
  return new JobPostDto({
    id: `job-${i}`,
    title: `Engineer ${i}`,
    companyName: 'Acme',
    jobUrl: `https://example.com/jobs/${i}`,
    site: 'linkedin',
  });
}

function createHarness(lruSize: number) {
  const ttl = 3_600_000;
  // Same construction as AppCacheModule's in-memory branch.
  const cacheManager = createCache({
    stores: [new Keyv({ store: new CacheableMemory({ ttl, lruSize }) })] as any,
    ttl,
  });
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'cache.enabled') return true;
      if (key === 'cache.expirySec') return 3600;
      if (key === 'cache.redisUrl') return undefined;
      return fallback;
    },
  };
  const metrics = { cacheHitsTotal: { inc: jest.fn() }, cacheMissesTotal: { inc: jest.fn() } };
  const cacheService = new CacheService(config as any, metrics as any, cacheManager as any);

  const jobs = Array.from({ length: 25 }, (_, i) => job(i));
  const jobsService = {
    assertSearchable: jest.fn(),
    searchJobsWithDiagnostics: jest.fn(async () => ({ jobs, perSource: [], completeness: { ...COMPLETE_SEARCH } })),
  };
  const aggregator = {
    aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
      jobs: raw,
      rawCount: raw.length,
      outputCount: raw.length,
      deduped: false,
    })),
  };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    {} as any,
    cacheService,
    config as any,
  );
  jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
  return { controller, jobsService, metrics };
}

type Page = { cached: boolean; current_page: number; jobs: JobPostDto[] };

const page = (controller: JobsController, n: number): Promise<Page> =>
  controller.searchJobs(
    new ScraperInputDto({ siteType: ['linkedin' as any], resultsWanted: 25 }),
    undefined,
    'true',
    String(n),
    '10',
  ) as Promise<Page>;

describe('JobsController — search cache with CACHE_MAX_ITEMS=1 (Spec 1721 / FR-19)', () => {
  it('page 2 of a paginated search is a cache hit: the fan-out runs once', async () => {
    const { controller, jobsService, metrics } = createHarness(1);

    const first = await page(controller, 1);
    const second = await page(controller, 2);

    expect(first).toMatchObject({ cached: false, current_page: 1 });
    expect(second).toMatchObject({ cached: true, current_page: 2 });
    expect(second.jobs.map((j) => j.id)).toEqual(Array.from({ length: 10 }, (_, i) => `job-${10 + i}`));
    expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
    expect(metrics.cacheHitsTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('an NDJSON request after a JSON page reads the completeness from the same entry (no fan-out)', async () => {
    const { controller, jobsService } = createHarness(1);
    await page(controller, 1);

    const res = { setHeader: jest.fn(), once: jest.fn() };
    const file = (await controller.searchJobs(
      new ScraperInputDto({ siteType: ['linkedin' as any], resultsWanted: 25 }),
      'ndjson',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      res as any,
    )) as { getStream: () => NodeJS.ReadableStream };
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
    const lines = Buffer.concat(chunks)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; complete?: boolean });

    expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.type === 'job')).toHaveLength(25);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'end', total: 25, complete: true });
  });
});
