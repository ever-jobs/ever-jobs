import 'reflect-metadata';
import {
  CanonicalJob,
  DedupResult,
  ERR_STORE_BACKEND_DOWN,
  IDedupEngine,
  IJobObservationStore,
  IJobStore,
  JobPostDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  ERR_STORE_PERSIST_FAILED,
  JobsAggregator,
} from '../jobs.aggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(id: string, overrides: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id,
    title: overrides.title ?? `Job ${id}`,
    companyName: overrides.companyName ?? 'Acme Corp',
    jobUrl: overrides.jobUrl ?? `https://example.com/job/${id}`,
    site: overrides.site ?? Site.LINKEDIN,
    isRemote: overrides.isRemote ?? false,
    description: overrides.description,
    datePosted: overrides.datePosted,
  });
}

function makeJobsService(jobs: JobPostDto[] = []) {
  return { searchJobs: jest.fn().mockResolvedValue(jobs) } as any;
}

/**
 * Stub IDedupEngine that maps each input job to one of the supplied
 * cluster ids. `clusterAssignments` length must equal the input length.
 *
 * The `withSources` flag (default `false`) makes each emitted canonical
 * record carry a single synthetic `SourceObservation` keyed by the
 * cluster id — exercised by the persistence tests so the
 * `IJobObservationStore.putAll` path runs end-to-end.
 */
function makeStubEngine(
  clusterAssignments: (string | null)[],
  opts: { withSources?: boolean } = {},
): IDedupEngine {
  return {
    dedup: jest.fn(async (jobs: ReadonlyArray<JobPostDto>) => {
      if (clusterAssignments.length !== jobs.length) {
        throw new Error('test stub: cluster assignments length mismatch');
      }
      const seen = new Set<string>();
      const canonical: any[] = [];
      for (const id of clusterAssignments) {
        if (id && !seen.has(id)) {
          seen.add(id);
          canonical.push({
            canonicalJobId: id,
            ...(opts.withSources
              ? {
                  sources: [
                    {
                      sourceId: 'test-source',
                      sourceJobId: id,
                      observedAt: new Date('2026-04-27T00:00:00Z').toISOString(),
                      raw: {} as JobPostDto,
                    },
                  ],
                }
              : {}),
          });
        }
      }
      const result: DedupResult = {
        canonical,
        assignments: clusterAssignments,
        errors: [],
        metrics: {
          inputCount: jobs.length,
          outputCount: canonical.length,
          mergedPairs: jobs.length - canonical.length,
          elapsedMs: 1,
        },
      };
      return result;
    }),
  };
}

/**
 * Stub `IJobStore` that records every `upsertMany` call and returns the
 * configured counts. Spread into `JobsAggregator`'s 3rd ctor arg via the
 * ctor's positional optionals.
 */
function makeStubStore(
  counts: { inserted: number; updated: number } = { inserted: 0, updated: 0 },
): IJobStore & { calls: ReadonlyArray<CanonicalJob>[] } {
  const calls: ReadonlyArray<CanonicalJob>[] = [];
  return {
    upsert: jest.fn(),
    upsertMany: jest.fn(async (jobs: ReadonlyArray<CanonicalJob>) => {
      calls.push(jobs);
      return counts;
    }),
    getById: jest.fn(),
    findByCanonicalId: jest.fn(),
    listByQuery: jest.fn(),
    delete: jest.fn(),
    calls,
  } as unknown as IJobStore & { calls: ReadonlyArray<CanonicalJob>[] };
}

/**
 * Stub `IJobStore` whose `upsertMany` rejects with a structured error
 * code — exercises the `persistError` capture path.
 */
function makeFailingStore(code: string = ERR_STORE_BACKEND_DOWN): IJobStore {
  const err = Object.assign(new Error('backend down'), { code });
  return {
    upsert: jest.fn(),
    upsertMany: jest.fn().mockRejectedValue(err),
    getById: jest.fn(),
    findByCanonicalId: jest.fn(),
    listByQuery: jest.fn(),
    delete: jest.fn(),
  } as unknown as IJobStore;
}

/**
 * Stub `IJobObservationStore` that records every `putAll(canonicalId, …)`
 * call so persistence tests can assert against the captured arguments.
 */
function makeStubObservationStore(): IJobObservationStore & {
  calls: Array<{ canonicalJobId: string; observations: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ canonicalJobId: string; observations: ReadonlyArray<unknown> }> = [];
  return {
    putAll: jest.fn(async (canonicalJobId: string, observations: ReadonlyArray<unknown>) => {
      calls.push({ canonicalJobId, observations });
    }),
    listByCanonicalId: jest.fn(),
    deleteByCanonicalId: jest.fn(),
    calls,
  } as unknown as IJobObservationStore & {
    calls: Array<{ canonicalJobId: string; observations: ReadonlyArray<unknown> }>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobsAggregator', () => {
  describe('aggregateRaw — pass-through paths', () => {
    it('returns raw jobs unchanged when no engine is bound', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const aggregator = new JobsAggregator(makeJobsService());

      const out = await aggregator.aggregateRaw(jobs);

      expect(out.jobs).toBe(jobs);
      expect(out.rawCount).toBe(2);
      expect(out.outputCount).toBe(2);
      expect(out.deduped).toBe(false);
      expect(out.dedupMetrics).toBeUndefined();
    });

    it('returns raw jobs unchanged when dedup=false even if engine is bound', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c1']); // would merge if invoked
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs, { dedup: false, careerLevels: undefined });

      expect(engine.dedup).not.toHaveBeenCalled();
      expect(out.jobs).toBe(jobs);
      expect(out.deduped).toBe(false);
    });

    it('handles empty raw lists without invoking the engine', async () => {
      const engine = makeStubEngine([]);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw([], { dedup: true, careerLevels: undefined });

      expect(engine.dedup).not.toHaveBeenCalled();
      expect(out.jobs).toEqual([]);
      expect(out.rawCount).toBe(0);
      expect(out.outputCount).toBe(0);
      expect(out.deduped).toBe(true);
      expect(out.dedupMetrics).toEqual({
        inputCount: 0,
        outputCount: 0,
        mergedPairs: 0,
        elapsedMs: 0,
      });
    });
  });

  describe('aggregateRaw — dedup paths', () => {
    it('collapses raw jobs into one representative per canonical cluster', async () => {
      // 3 jobs, all in the same cluster
      const jobs = [makeJob('1'), makeJob('2'), makeJob('3')];
      const engine = makeStubEngine(['c1', 'c1', 'c1']);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs, { dedup: true, careerLevels: undefined });

      expect(out.jobs).toHaveLength(1);
      expect(out.jobs[0].id).toBe('1'); // first input is the representative
      expect(out.rawCount).toBe(3);
      expect(out.outputCount).toBe(1);
      expect(out.deduped).toBe(true);
      expect(out.dedupMetrics).toMatchObject({ inputCount: 3, outputCount: 1, mergedPairs: 2 });
    });

    it('keeps insertion order of canonical clusters', async () => {
      // 4 jobs; clusters: a, b, a, b  → output should be [j0, j1] in that order
      const jobs = [
        makeJob('j0'),
        makeJob('j1'),
        makeJob('j2'),
        makeJob('j3'),
      ];
      const engine = makeStubEngine(['a', 'b', 'a', 'b']);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs, { dedup: true, careerLevels: undefined });

      expect(out.jobs.map((j) => j.id)).toEqual(['j0', 'j1']);
    });

    it('drops engine-rejected entries (assignments[i] === null)', async () => {
      const jobs = [makeJob('1'), makeJob('2'), makeJob('3')];
      const engine = makeStubEngine([null, 'c1', 'c2']);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs, { dedup: true, careerLevels: undefined });

      expect(out.jobs.map((j) => j.id)).toEqual(['2', '3']);
      expect(out.outputCount).toBe(2);
      expect(out.rawCount).toBe(3);
    });

    it('default dedup option is true when an engine is bound', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c1']);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs);

      expect(engine.dedup).toHaveBeenCalled();
      expect(out.deduped).toBe(true);
      expect(out.outputCount).toBe(1);
    });
  });

  describe('aggregate (full pipeline)', () => {
    it('delegates fan-out to JobsService and then runs dedup', async () => {
      const fanned = [makeJob('1'), makeJob('2')];
      const jobsService = makeJobsService(fanned);
      const engine = makeStubEngine(['c1', 'c1']);
      const aggregator = new JobsAggregator(jobsService, engine);

      const out = await aggregator.aggregate(new ScraperInputDto({ searchTerm: 'node' }));

      expect(jobsService.searchJobs).toHaveBeenCalledTimes(1);
      expect(engine.dedup).toHaveBeenCalledWith(fanned);
      expect(out.outputCount).toBe(1);
      expect(out.deduped).toBe(true);
    });

    it('skips dedup when {dedup:false} even via aggregate()', async () => {
      const fanned = [makeJob('1'), makeJob('2')];
      const jobsService = makeJobsService(fanned);
      const engine = makeStubEngine(['c1', 'c1']);
      const aggregator = new JobsAggregator(jobsService, engine);

      const out = await aggregator.aggregate(
        new ScraperInputDto({ searchTerm: 'node' }),
        { dedup: false },
      );

      expect(engine.dedup).not.toHaveBeenCalled();
      expect(out.deduped).toBe(false);
      expect(out.jobs).toBe(fanned);
    });
  });

  // ---------------------------------------------------------------------------
  // Spec 004 / T11 — persistence
  // ---------------------------------------------------------------------------

  describe('aggregateRaw — persistence (Spec 004 / T11)', () => {
    it('upserts post-dedup canonical records when a store is bound (default)', async () => {
      const jobs = [makeJob('1'), makeJob('2'), makeJob('3')];
      const engine = makeStubEngine(['c1', 'c1', 'c2']);
      const store = makeStubStore({ inserted: 2, updated: 0 });
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs);

      expect(store.upsertMany).toHaveBeenCalledTimes(1);
      // canonical[] from the engine: one record per cluster.
      const persisted = (store as any).calls[0] as ReadonlyArray<CanonicalJob>;
      expect(persisted.map((c) => c.canonicalJobId)).toEqual(['c1', 'c2']);
      expect(out.persisted).toBe(true);
      expect(out.persistCounts).toEqual({ inserted: 2, updated: 0 });
      expect(out.persistError).toBeUndefined();
    });

    it('persist=false short-circuits the upsert side-effect', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c1']);
      const store = makeStubStore();
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs, { persist: false, careerLevels: undefined });

      expect(store.upsertMany).not.toHaveBeenCalled();
      expect(out.persisted).toBeUndefined();
      expect(out.persistCounts).toBeUndefined();
      expect(out.persistError).toBeUndefined();
      // Dedup still ran and shaped the response normally.
      expect(out.deduped).toBe(true);
      expect(out.outputCount).toBe(1);
    });

    it('silently skips persistence when no IJobStore is bound (no error)', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c2']);
      const aggregator = new JobsAggregator(makeJobsService(), engine);

      const out = await aggregator.aggregateRaw(jobs);

      expect(out.deduped).toBe(true);
      expect(out.persisted).toBeUndefined();
      expect(out.persistError).toBeUndefined();
    });

    it('captures persistence failures via persistError without bubbling', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c1']);
      const store = makeFailingStore(ERR_STORE_BACKEND_DOWN);
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs);

      expect(store.upsertMany).toHaveBeenCalledTimes(1);
      expect(out.persisted).toBe(false);
      expect(out.persistCounts).toBeUndefined();
      expect(out.persistError).toEqual({
        code: ERR_STORE_BACKEND_DOWN,
        message: 'backend down',
      });
      // Hot-path response is unaffected.
      expect(out.deduped).toBe(true);
      expect(out.outputCount).toBe(1);
      expect(out.jobs).toHaveLength(1);
    });

    it('falls back to ERR_STORE_PERSIST_FAILED when rejection has no .code', async () => {
      const jobs = [makeJob('1')];
      const engine = makeStubEngine(['c1']);
      const store = {
        upsert: jest.fn(),
        upsertMany: jest.fn().mockRejectedValue(new Error('boom')),
        getById: jest.fn(),
        findByCanonicalId: jest.fn(),
        listByQuery: jest.fn(),
        delete: jest.fn(),
      } as unknown as IJobStore;
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs);

      expect(out.persisted).toBe(false);
      expect(out.persistError?.code).toBe(ERR_STORE_PERSIST_FAILED);
      expect(out.persistError?.message).toBe('boom');
    });

    it('writes observations via IJobObservationStore.putAll when bound', async () => {
      const jobs = [makeJob('1'), makeJob('2'), makeJob('3')];
      const engine = makeStubEngine(['c1', 'c1', 'c2'], { withSources: true });
      const store = makeStubStore({ inserted: 0, updated: 2 });
      const obs = makeStubObservationStore();
      const aggregator = new JobsAggregator(
        makeJobsService(),
        engine,
        store,
        obs,
      );

      const out = await aggregator.aggregateRaw(jobs);

      expect(out.persisted).toBe(true);
      expect(out.persistCounts).toEqual({ inserted: 0, updated: 2 });
      // One putAll call per canonical record; observations propagated unchanged.
      expect(obs.putAll).toHaveBeenCalledTimes(2);
      expect((obs as any).calls.map((c: any) => c.canonicalJobId).sort()).toEqual([
        'c1',
        'c2',
      ]);
    });

    it('treats observation-store failures as best-effort (canonical still persisted)', async () => {
      const jobs = [makeJob('1')];
      const engine = makeStubEngine(['c1'], { withSources: true });
      const store = makeStubStore({ inserted: 1, updated: 0 });
      const obs = {
        putAll: jest.fn().mockRejectedValue(new Error('observation insert failed')),
        listByCanonicalId: jest.fn(),
        deleteByCanonicalId: jest.fn(),
      } as unknown as IJobObservationStore;
      const aggregator = new JobsAggregator(
        makeJobsService(),
        engine,
        store,
        obs,
      );

      const out = await aggregator.aggregateRaw(jobs);

      // Canonical write succeeded → persisted: true. Observation rejection
      // is logged via Promise.allSettled but does NOT flip persisted to false.
      expect(out.persisted).toBe(true);
      expect(out.persistCounts).toEqual({ inserted: 1, updated: 0 });
      expect(out.persistError).toBeUndefined();
      expect(obs.putAll).toHaveBeenCalledTimes(1);
    });

    it('does not call upsertMany on the empty-canonical edge', async () => {
      // All assignments null → result.canonical is empty; no need for a
      // round-trip to the store on a no-op dedup pass.
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine([null, null]);
      const store = makeStubStore();
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs);

      expect(store.upsertMany).not.toHaveBeenCalled();
      expect(out.persisted).toBeUndefined();
      expect(out.outputCount).toBe(0);
    });

    it('does not persist on the dedup=false pass-through path', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const engine = makeStubEngine(['c1', 'c1']);
      const store = makeStubStore();
      const aggregator = new JobsAggregator(makeJobsService(), engine, store);

      const out = await aggregator.aggregateRaw(jobs, { dedup: false, careerLevels: undefined });

      expect(store.upsertMany).not.toHaveBeenCalled();
      expect(out.deduped).toBe(false);
      expect(out.persisted).toBeUndefined();
    });

    it('does not persist when no engine is bound (pure pass-through)', async () => {
      const jobs = [makeJob('1'), makeJob('2')];
      const store = makeStubStore();
      const aggregator = new JobsAggregator(makeJobsService(), undefined, store);

      const out = await aggregator.aggregateRaw(jobs);

      expect(store.upsertMany).not.toHaveBeenCalled();
      expect(out.deduped).toBe(false);
      expect(out.persisted).toBeUndefined();
    });
  });
});
