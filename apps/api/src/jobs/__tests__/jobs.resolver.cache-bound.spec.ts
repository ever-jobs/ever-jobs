import 'reflect-metadata';
import { JobPostDto } from '@ever-jobs/models';
import { JobsResolver } from '../jobs.resolver';
import { SearchJobsInput } from '../gql-types';

/** Spec 1720 / FR-13 — the GraphQL search honours EVER_JOBS_CACHE_MAX_JOBS like REST. */
describe('JobsResolver — cache bound (Spec 1720 / FR-13)', () => {
  function run(jobCount: number, config: Record<string, unknown>, completeness?: { complete: boolean; stopReason: string | null }) {
    const jobs = Array.from(
      { length: jobCount },
      (_, i) => new JobPostDto({ id: `j${i}`, title: `Role ${i}`, jobUrl: `https://e.test/${i}` }),
    );
    const cacheService = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    const resolver = new JobsResolver(
      { searchJobsWithDiagnostics: jest.fn().mockResolvedValue({ jobs, perSource: [], completeness }) } as any,
      {
        aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
          jobs: raw,
          rawCount: raw.length,
          outputCount: raw.length,
          deduped: false,
        })),
      } as any,
      cacheService as any,
      { get: (k: string, def?: unknown) => (k in config ? config[k] : def) } as any,
    );
    const input = new SearchJobsInput();
    input.searchTerm = 'node';
    return { cacheService, done: resolver.searchJobs(input) };
  }

  it('caches a set at the limit', async () => {
    const { cacheService, done } = run(2, { 'cache.maxJobs': 2 });
    await done;
    expect(cacheService.set).toHaveBeenCalledTimes(1);
  });

  it('serves but does not cache a set above the limit', async () => {
    const { cacheService, done } = run(3, { 'cache.maxJobs': 2 });
    expect((await done).count).toBe(3);
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  it('serves but does not cache an incomplete crawl (Spec 1721 / FR-20)', async () => {
    const { cacheService, done } = run(2, { 'cache.maxJobs': 5000 }, { complete: false, stopReason: 'deadline' });
    expect((await done).count).toBe(2);
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  it('caches a complete crawl', async () => {
    const { cacheService, done } = run(2, { 'cache.maxJobs': 5000 }, { complete: true, stopReason: null });
    await done;
    expect(cacheService.set).toHaveBeenCalledTimes(1);
  });

  it('0 never caches', async () => {
    const { cacheService, done } = run(1, { 'cache.maxJobs': 0 });
    await done;
    expect(cacheService.set).not.toHaveBeenCalled();
  });
});
