import 'reflect-metadata';
import { JobPostDto, Site } from '@ever-jobs/models';
import { JobsResolver } from '../jobs.resolver';
import { SearchJobsInput } from '../gql-types';

// ---------------------------------------------------------------------------
// Mocks (mirrors apps/api/src/jobs/__tests__/jobs.controller.spec.ts patterns
// so REST + GraphQL behaviour is validated against the same fixtures).
// ---------------------------------------------------------------------------

function makeJobsService(jobs: JobPostDto[] = []) {
  return { searchJobs: jest.fn().mockResolvedValue(jobs) };
}

function makeCacheService(cachedValue: any = null) {
  return {
    get: jest.fn().mockResolvedValue(cachedValue),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Pass-through aggregator stub. Mirrors the production
 * "no engine bound → return raw" path so resolver tests that don't care
 * about the engine still work.
 */
function makePassthroughAggregator() {
  return {
    aggregateRaw: jest.fn(async (rawJobs: JobPostDto[], options: { dedup?: boolean } = {}) => ({
      jobs: rawJobs,
      rawCount: rawJobs.length,
      outputCount: rawJobs.length,
      deduped: false,
      dedupMetrics: undefined,
      _calledWith: options,
    })),
    aggregate: jest.fn(),
  };
}

function createResolver(opts: { jobs?: JobPostDto[]; cachedValue?: any; aggregator?: any } = {}) {
  const jobsService = makeJobsService(opts.jobs ?? []);
  const cacheService = makeCacheService(opts.cachedValue);
  const aggregator = opts.aggregator ?? makePassthroughAggregator();
  // Spec 5024 — ConfigService seam (see jobs.controller.spec.ts).
  const configService = { get: (_key: string, def?: unknown) => def };
  const resolver = new JobsResolver(
    jobsService as any,
    aggregator as any,
    cacheService as any,
    configService as any,
  );
  return { resolver, jobsService, cacheService, aggregator };
}

function makeJob(overrides: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id: overrides.id ?? 'test-1',
    title: overrides.title ?? 'Software Engineer',
    companyName: overrides.companyName ?? 'Acme Corp',
    jobUrl: overrides.jobUrl ?? 'https://example.com/job/1',
    site: overrides.site ?? 'linkedin',
    isRemote: overrides.isRemote ?? false,
    ...overrides,
  });
}

function makeInput(overrides: Partial<SearchJobsInput> = {}): SearchJobsInput {
  const input = new SearchJobsInput();
  input.searchTerm = overrides.searchTerm ?? 'node';
  if ('location' in overrides) input.location = overrides.location;
  if ('resultsWanted' in overrides) input.resultsWanted = overrides.resultsWanted;
  if ('country' in overrides) input.country = overrides.country;
  if ('distance' in overrides) input.distance = overrides.distance;
  if ('companySlug' in overrides) input.companySlug = overrides.companySlug;
  if ('descriptionFormat' in overrides) input.descriptionFormat = overrides.descriptionFormat;
  if ('siteType' in overrides) input.siteType = overrides.siteType;
  if ('dedup' in overrides) input.dedup = overrides.dedup;
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobsResolver', () => {
  describe('searchJobs — basic shape', () => {
    it('returns count, jobs, cached, deduped, rawCount on a cache miss', async () => {
      const jobs = [makeJob({ title: 'SWE' }), makeJob({ id: 'test-2', title: 'PM' })];
      const { resolver } = createResolver({ jobs });

      const result = await resolver.searchJobs(makeInput());

      expect(result).toMatchObject({
        count: 2,
        jobs,
        cached: false,
        deduped: false,
        rawCount: 2,
      });
      expect(result.dedupMetrics).toBeUndefined();
    });

    it('returns cached results without calling JobsService', async () => {
      const cachedJobs = [makeJob({ title: 'Cached Job' })];
      const { resolver, jobsService } = createResolver({ cachedValue: cachedJobs });

      const result = await resolver.searchJobs(makeInput());

      expect(result).toMatchObject({
        count: 1,
        jobs: cachedJobs,
        cached: true,
        rawCount: 1,
      });
      expect(jobsService.searchJobs).not.toHaveBeenCalled();
    });

    it('caches raw jobs on miss', async () => {
      const jobs = [makeJob()];
      const { resolver, cacheService } = createResolver({ jobs });

      await resolver.searchJobs(makeInput());

      expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), jobs);
    });

    it('uses the v2 cache key under endpoint=graphql-search-v2', async () => {
      const jobs = [makeJob()];
      const { resolver, cacheService } = createResolver({ jobs });

      await resolver.searchJobs(makeInput({ searchTerm: 'rust' }));

      const params = cacheService.set.mock.calls[0]?.[0];
      expect(params).toBeDefined();
      expect(params.endpoint).toBe('graphql-search-v2');
      // dedup flag is intentionally scrubbed from the cache key so toggling
      // ?dedup= doesn't blow away cache entries.
      expect(params.dedup).toBeUndefined();
    });
  });

  describe('searchJobs — dedup arg (Spec 003 / T15)', () => {
    it('defaults to dedup=true when input.dedup is omitted', async () => {
      const jobs = [makeJob()];
      const { resolver, aggregator } = createResolver({ jobs });

      await resolver.searchJobs(makeInput());

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true });
    });

    it('honours dedup: false explicitly', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const { resolver, aggregator } = createResolver({ jobs });

      await resolver.searchJobs(makeInput({ dedup: false }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: false, persist: true });
    });

    it('honours dedup: true explicitly', async () => {
      const jobs = [makeJob()];
      const { resolver, aggregator } = createResolver({ jobs });

      await resolver.searchJobs(makeInput({ dedup: true }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true });
    });

    it('runs dedup on cached responses too', async () => {
      const cachedJobs = [makeJob({ title: 'Cached' })];
      const { resolver, jobsService, aggregator } = createResolver({ cachedValue: cachedJobs });

      await resolver.searchJobs(makeInput());

      expect(jobsService.searchJobs).not.toHaveBeenCalled();
      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(cachedJobs, { dedup: true, persist: true });
    });

    it('surfaces dedupMetrics + collapsed count when the engine ran', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const fakeMetrics = {
        inputCount: 2,
        outputCount: 1,
        mergedPairs: 1,
        elapsedMs: 7,
      };
      const aggregator = {
        aggregateRaw: jest.fn().mockResolvedValue({
          jobs: [jobs[0]],
          rawCount: 2,
          outputCount: 1,
          deduped: true,
          dedupMetrics: fakeMetrics,
        }),
        aggregate: jest.fn(),
      };
      const { resolver } = createResolver({ jobs, aggregator });

      const result = await resolver.searchJobs(makeInput());

      expect(result.deduped).toBe(true);
      expect(result.rawCount).toBe(2);
      expect(result.count).toBe(1);
      expect(result.dedupMetrics).toEqual(fakeMetrics);
    });

    it('cache key strips the dedup flag so toggling does not split entries', async () => {
      const jobs = [makeJob()];
      const { resolver, cacheService } = createResolver({ jobs });

      await resolver.searchJobs(makeInput({ dedup: false }));
      const noDedupParams = cacheService.set.mock.calls[0]?.[0];

      cacheService.set.mockClear();
      await resolver.searchJobs(makeInput({ dedup: true }));
      const dedupParams = cacheService.set.mock.calls[0]?.[0];

      expect(noDedupParams).toEqual(dedupParams);
    });

    it('preserves raw fan-out in the cache (engine version is decoupled)', async () => {
      const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b' })];
      const aggregator = {
        // Pretend the engine collapsed both into one — cache must still hold both.
        aggregateRaw: jest.fn().mockResolvedValue({
          jobs: [jobs[0]],
          rawCount: 2,
          outputCount: 1,
          deduped: true,
          dedupMetrics: { inputCount: 2, outputCount: 1, mergedPairs: 1, elapsedMs: 1 },
        }),
        aggregate: jest.fn(),
      };
      const { resolver, cacheService } = createResolver({ jobs, aggregator });

      await resolver.searchJobs(makeInput());

      // cacheService.set must receive the unmodified raw list (not the deduped one)
      expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), jobs);
    });
  });

  describe('searchJobs — input mapping', () => {
    it('forwards location, country, distance, companySlug, siteType, descriptionFormat', async () => {
      const jobs = [makeJob()];
      const { resolver, jobsService } = createResolver({ jobs });

      await resolver.searchJobs(
        makeInput({
          searchTerm: 'engineer',
          location: 'NYC',
          country: 'USA',
          distance: 25,
          companySlug: 'acme',
          descriptionFormat: 'html',
          siteType: [Site.LINKEDIN],
          resultsWanted: 50,
        }),
      );

      expect(jobsService.searchJobs).toHaveBeenCalledWith(
        expect.objectContaining({
          searchTerm: 'engineer',
          location: 'NYC',
          country: 'USA',
          distance: 25,
          companySlug: 'acme',
          descriptionFormat: 'html',
          siteType: [Site.LINKEDIN],
          resultsWanted: 50,
        }),
      );
    });

    it('defaults resultsWanted to 20 and descriptionFormat to markdown', async () => {
      const jobs = [makeJob()];
      const { resolver, jobsService } = createResolver({ jobs });

      await resolver.searchJobs(makeInput());

      expect(jobsService.searchJobs).toHaveBeenCalledWith(
        expect.objectContaining({
          resultsWanted: 20,
          descriptionFormat: 'markdown',
        }),
      );
    });
  });

  describe('listSources', () => {
    it('returns every Site enum value with name + value pairs', () => {
      const { resolver } = createResolver();

      const result = resolver.listSources();

      const expectedTotal = Object.entries(Site).length;
      expect(result.total).toBe(expectedTotal);
      expect(result.sources).toHaveLength(expectedTotal);
      // Sanity: the LinkedIn entry is present.
      expect(result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.any(String), value: expect.any(String) }),
        ]),
      );
    });
  });
});
