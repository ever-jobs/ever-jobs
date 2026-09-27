import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import {
  CanonicalJob,
  DedupResult,
  IDedupEngine,
  IJobObservationStore,
  IJobStore,
  JobPostDto,
  ObservationBatchEntry,
  Site,
} from '@ever-jobs/models';
import { JobsAggregator, OBSERVATION_WRITE_CONCURRENCY } from '../jobs.aggregator';

/**
 * Spec 1722 / FR-13 — how the aggregator writes observations at list-mode
 * size. Before the fix it called `putAll` once per canonical job, all at
 * once (`Promise.allSettled(canonical.map(putAll))`): 25 k simultaneous
 * transactions for a list-mode search, which drained the Postgres pool.
 */

function jobs(n: number): JobPostDto[] {
  return Array.from(
    { length: n },
    (_, i) =>
      new JobPostDto({
        id: `j${i}`,
        title: `Engineer ${i}`,
        companyName: 'Acme',
        jobUrl: `https://example.com/${i}`,
        site: Site.LINKEDIN,
      }),
  );
}

/** Engine that makes every input its own canonical record with one observation. */
function oneClusterPerJob(): IDedupEngine {
  return {
    dedup: jest.fn(async (input: ReadonlyArray<JobPostDto>) => {
      const canonical = input.map(
        (job, i) =>
          ({
            canonicalJobId: `c${i}`,
            title: job.title,
            company: 'Acme',
            location: '',
            url: job.jobUrl,
            mergedAt: '2026-09-25T00:00:00.000Z',
            fields: {},
            sources: [
              {
                site: Site.LINKEDIN,
                sourceJobId: String(job.id),
                url: job.jobUrl,
                observedAt: '2026-09-24T00:00:00.000Z',
              },
            ],
          }) as unknown as CanonicalJob,
      );
      const result: DedupResult = {
        canonical,
        assignments: canonical.map((c) => c.canonicalJobId),
        errors: [],
        metrics: { inputCount: input.length, outputCount: input.length, mergedPairs: 0, elapsedMs: 1 },
      };
      return result;
    }),
  };
}

function store(): IJobStore {
  return {
    upsert: jest.fn(),
    upsertMany: jest.fn(async (rows: ReadonlyArray<CanonicalJob>) => ({ inserted: rows.length, updated: 0 })),
    getById: jest.fn(),
    findByCanonicalId: jest.fn(),
    listByQuery: jest.fn(),
    delete: jest.fn(),
  } as unknown as IJobStore;
}

describe('JobsAggregator — observation writes (Spec 1722 / FR-13)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('hands the whole set to putAllMany in ONE call when the store has it', async () => {
    const batches: Array<ReadonlyArray<ObservationBatchEntry>> = [];
    const obs = {
      putAll: jest.fn(),
      putAllMany: jest.fn(async (entries: ReadonlyArray<ObservationBatchEntry>) => {
        batches.push(entries);
      }),
      listByCanonicalId: jest.fn(),
      deleteByCanonicalId: jest.fn(),
    } as unknown as IJobObservationStore;
    const aggregator = new JobsAggregator({} as never, oneClusterPerJob(), store(), obs);

    const out = await aggregator.aggregateRaw(jobs(1_000));

    expect(out.persisted).toBe(true);
    expect(obs.putAll).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1_000);
    expect(batches[0]![0]).toEqual({
      canonicalJobId: 'c0',
      observations: [expect.objectContaining({ sourceJobId: 'j0', site: Site.LINKEDIN })],
    });
  });

  it('a putAllMany failure is logged and never flips persisted', async () => {
    const obs = {
      putAll: jest.fn(),
      putAllMany: jest.fn().mockRejectedValue(Object.assign(new Error('pool exhausted'), { code: 'P2024' })),
      listByCanonicalId: jest.fn(),
      deleteByCanonicalId: jest.fn(),
    } as unknown as IJobObservationStore;
    const aggregator = new JobsAggregator({} as never, oneClusterPerJob(), store(), obs);

    const out = await aggregator.aggregateRaw(jobs(3));

    expect(out.persisted).toBe(true);
    expect(out.persistError).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/batch of 3: P2024 — pool exhausted/));
  });

  it(`without putAllMany, never has more than ${OBSERVATION_WRITE_CONCURRENCY} putAll calls in flight`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const written: string[] = [];
    const obs = {
      putAll: jest.fn(async (canonicalJobId: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        written.push(canonicalJobId);
        inFlight--;
      }),
      listByCanonicalId: jest.fn(),
      deleteByCanonicalId: jest.fn(),
    } as unknown as IJobObservationStore;
    const aggregator = new JobsAggregator({} as never, oneClusterPerJob(), store(), obs);

    const out = await aggregator.aggregateRaw(jobs(200));

    expect(out.persisted).toBe(true);
    expect(written).toHaveLength(200);
    expect(new Set(written).size).toBe(200);
    // Red before the fix: all 200 were started at once.
    expect(maxInFlight).toBeLessThanOrEqual(OBSERVATION_WRITE_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('without putAllMany, failures are counted in one warning and the rest still get written', async () => {
    const obs = {
      putAll: jest.fn(async (canonicalJobId: string) => {
        if (['c3', 'c7', 'c11'].includes(canonicalJobId)) throw new Error(`fk violation ${canonicalJobId}`);
      }),
      listByCanonicalId: jest.fn(),
      deleteByCanonicalId: jest.fn(),
    } as unknown as IJobObservationStore;
    const aggregator = new JobsAggregator({} as never, oneClusterPerJob(), store(), obs);

    const out = await aggregator.aggregateRaw(jobs(20));

    expect(out.persisted).toBe(true);
    expect(obs.putAll).toHaveBeenCalledTimes(20);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3 of 20 putAll calls failed \(first: fk violation c3\)/));
  });
});
