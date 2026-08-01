import 'reflect-metadata';
import {
  ScraperInputDto,
  JobPostDto,
  JobAnalysisDto,
} from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeJobsService(jobs: JobPostDto[] = []) {
  return { searchJobs: jest.fn().mockResolvedValue(jobs) };
}

function makeAnalyticsService() {
  return {
    analyze: jest.fn().mockReturnValue({
      summary: { totalJobs: 1, remoteCount: 0, remotePercentage: 0, withSalaryCount: 0, salaryStats: null, bySite: {} },
      companies: [],
      siteComparison: [],
    }),
  };
}

function makeCacheService(cachedValue: any = null) {
  return {
    get: jest.fn().mockReturnValue(cachedValue),
    set: jest.fn(),
  };
}

/**
 * Pass-through aggregator stub. Mirrors the production
 * "no engine bound → return raw" path so existing controller tests
 * keep their pre-Phase-5 semantics.
 */
function makePassthroughAggregator() {
  return {
    aggregateRaw: jest.fn(async (rawJobs: JobPostDto[], options: { dedup?: boolean } = {}) => ({
      jobs: rawJobs,
      rawCount: rawJobs.length,
      outputCount: rawJobs.length,
      deduped: false,
      dedupMetrics: undefined,
      // record the option so dedup-flag tests can assert on it
      _calledWith: options,
    })),
    aggregate: jest.fn(),
  };
}

function createController(opts: { jobs?: JobPostDto[]; cachedValue?: any; aggregator?: any } = {}) {
  const jobsService = makeJobsService(opts.jobs ?? []);
  const analyticsService = makeAnalyticsService();
  const cacheService = makeCacheService(opts.cachedValue);
  const aggregator = opts.aggregator ?? makePassthroughAggregator();
  // Spec 5024 — ConfigService seam. Returning the caller's default keeps
  // `store.persistSearch` at its `true` default for these cases.
  const configService = { get: (_key: string, def?: unknown) => def };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    analyticsService as any,
    cacheService as any,
    configService as any,
  );
  return { controller, jobsService, cacheService, analyticsService, aggregator };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobsController', () => {
  describe('POST /search — JSON responses', () => {
    it('should return job results with count', async () => {
      const jobs = [makeJob({ title: 'SWE' }), makeJob({ title: 'PM' })];
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      ) as any;

      expect(result).toMatchObject({
        count: 2,
        jobs,
        cached: false,
        deduped: false,        // pass-through aggregator → no engine bound
        raw_count: 2,
      });
    });

    it('should return cached results when available', async () => {
      const cachedJobs = [makeJob({ title: 'Cached Job' })];
      const { controller, jobsService } = createController({ cachedValue: cachedJobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      ) as any;

      expect(result).toMatchObject({
        count: 1,
        jobs: cachedJobs,
        cached: true,
        deduped: false,
        raw_count: 1,
      });
      // Should NOT call jobsService when cache hit
      expect(jobsService.searchJobs).not.toHaveBeenCalled();
    });

    it('should cache results on miss', async () => {
      const jobs = [makeJob()];
      const { controller, cacheService } = createController({ jobs });

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'node' }));

      expect(cacheService.set).toHaveBeenCalledWith(
        expect.any(Object),
        jobs,
      );
    });
  });

  describe('POST /search — pagination', () => {
    it('should paginate results when paginate=true', async () => {
      const jobs = Array.from({ length: 25 }, (_, i) =>
        makeJob({ id: `job-${i}`, title: `Job ${i}` }),
      );
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',   // paginate
        '2',      // page
        '10',     // page_size
      ) as any;

      expect(result).toMatchObject({
        count: 25,
        total_pages: 3,
        current_page: 2,
        page_size: 10,
        next_page: 3,
        previous_page: 1,
        cached: false,
      });
      expect(result.jobs).toHaveLength(10);
    });

    it('should clamp page_size to max 100', async () => {
      const jobs = Array.from({ length: 5 }, () => makeJob());
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',
        '1',
        '999',  // exceeds max
      ) as any;

      expect(result.page_size).toBe(100);
    });

    it('should return null for next_page on last page', async () => {
      const jobs = [makeJob()];
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',
        '1',
        '10',
      ) as any;

      expect(result.next_page).toBeNull();
      expect(result.previous_page).toBeNull();
    });
  });

  describe('POST /search — CSV export', () => {
    it('should return CSV when format=csv', async () => {
      const jobs = [
        makeJob({ title: 'SWE', companyName: 'Acme' }),
      ];
      const { controller } = createController({ jobs });

      const mockRes = {
        setHeader: jest.fn(),
      };

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        'csv',
        undefined,
        undefined,
        undefined,
        undefined,    // dedup
        undefined,    // liveness  (Spec 740)
        undefined,    // legitimacy (Spec 740)
        mockRes as any,
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename=jobs.csv',
      );
      // Result should be a StreamableFile
      expect(result).toBeDefined();
    });
  });

  describe('POST /search — persist flag (Spec 5024)', () => {
    /** Build a controller whose ConfigService reports a given store.persistSearch. */
    function createWithPersist(persistSearch: boolean, jobs: JobPostDto[]) {
      const jobsService = makeJobsService(jobs);
      const analyticsService = makeAnalyticsService();
      const cacheService = makeCacheService(undefined);
      const aggregator = makePassthroughAggregator();
      const configService = {
        get: (key: string, def?: unknown) =>
          key === 'store.persistSearch' ? persistSearch : def,
      };
      const controller = new JobsController(
        jobsService as any,
        aggregator as any,
        analyticsService as any,
        cacheService as any,
        configService as any,
      );
      return { controller, aggregator };
    }

    it('passes persist=true by default (historical behaviour)', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(true, jobs);

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'engineer' }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: true,
        persist: true,
      });
    });

    it('passes persist=false when EVER_JOBS_PERSIST_SEARCH is disabled', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(false, jobs);

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'engineer' }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: true,
        persist: false,
      });
    });

    it('the persist flag is independent of the dedup flag', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(false, jobs);

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'engineer' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'false', // dedup=false
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: false,
        persist: false,
      });
    });
  });

  describe('POST /search — dedup flag (Spec 003 / T14)', () => {
    it('defaults dedup=true when query param is absent', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true });
    });

    it('honours dedup=false explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,    // format
        undefined,    // paginate
        undefined,    // page
        undefined,    // page_size
        'false',      // dedup
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: false, persist: true });
    });

    it('honours dedup=0 explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        '0',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: false, persist: true });
    });

    it('honours dedup=true explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'true',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true });
    });

    it('falls back to dedup=true on garbage values', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'not-a-bool',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true });
    });

    it('runs dedup on cached responses too', async () => {
      const cachedJobs = [makeJob({ title: 'Cached' })];
      const { controller, jobsService, aggregator } = createController({ cachedValue: cachedJobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(jobsService.searchJobs).not.toHaveBeenCalled();
      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(cachedJobs, { dedup: true, persist: true });
    });

    it('caches RAW jobs (pre-dedup) so cache invalidation is independent of engine version', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const { controller, cacheService } = createController({ jobs });

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'node' }));

      // Cache write should hold the unmodified raw list
      expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), jobs);
    });

    it('returns dedup_metrics when the engine ran', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const fakeMetrics = {
        inputCount: 2,
        outputCount: 1,
        mergedPairs: 1,
        elapsedMs: 4,
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
      const { controller } = createController({ jobs, aggregator });

      const result = (await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      )) as any;

      expect(result.deduped).toBe(true);
      expect(result.raw_count).toBe(2);
      expect(result.count).toBe(1);
      expect(result.dedup_metrics).toEqual(fakeMetrics);
    });
  });

  describe('POST /analyze', () => {
    it('should search then analyze jobs', async () => {
      const jobs = [makeJob()];
      const { controller, analyticsService } = createController({ jobs });

      const result = await controller.analyzeJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(analyticsService.analyze).toHaveBeenCalledWith(jobs);
      expect(result.summary).toBeDefined();
      expect(result.summary.totalJobs).toBe(1);
    });
  });
});
