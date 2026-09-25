import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CareerLevelClassifierModule, CareerLevelClassifierService } from '@ever-jobs/career-level-classifier';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import {
  type DedupResult,
  type ICareerLevelClassifier,
  type IDedupEngine,
  JobPostDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

import configuration from '../../config/configuration';
import { JobsAggregator } from '../jobs.aggregator';
import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';

/**
 * Spec 1730 (contract C7) — the aggregator attaches `careerLevel` to every returned job after
 * dedup, honours `EVER_JOBS_CLASSIFY_CAREER_LEVEL`, and applies the `careerLevels` filter.
 */

function job(id: string, title: string, extra: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id,
    title,
    companyName: extra.companyName ?? `Company ${id}`,
    jobUrl: `https://example.com/${id}`,
    site: extra.site ?? Site.LINKEDIN,
    ...extra,
  });
}

function sampleJobs(): JobPostDto[] {
  return [
    job('1', 'Software Engineer Intern'),
    job('2', 'Software Engineer, New Grad'),
    job('3', 'Senior Software Engineer'),
    job('4', 'Engineering Manager'),
    job('5', 'Barista'),
    job('6', 'Software Engineer', { jobType: [JobType.INTERNSHIP], jobLevel: 'Internship' }),
  ];
}

const jobsService = { searchJobs: jest.fn() } as unknown as JobsService;
const classifier = new CareerLevelClassifierService();
const config = (classify: boolean) =>
  ({ get: (key: string, def?: unknown) => (key === 'careerLevel.classify' ? classify : def) }) as unknown as ConfigService;

/** Engine stub collapsing every job with the same title into one cluster. */
function titleEngine(): IDedupEngine {
  return {
    dedup: jest.fn(async (jobs: ReadonlyArray<JobPostDto>): Promise<DedupResult> => {
      const assignments = jobs.map((j) => `c:${j.title}`);
      const canonical = [...new Set(assignments)].map((id) => ({ canonicalJobId: id })) as never[];
      return {
        canonical,
        assignments,
        errors: [],
        metrics: { inputCount: jobs.length, outputCount: canonical.length, mergedPairs: jobs.length - canonical.length, elapsedMs: 0 },
      };
    }),
  };
}

function aggregator(opts: { engine?: IDedupEngine; classify?: boolean; classifier?: ICareerLevelClassifier | null } = {}) {
  return new JobsAggregator(
    jobsService,
    opts.engine,
    undefined,
    undefined,
    opts.classifier === null ? undefined : (opts.classifier ?? classifier),
    config(opts.classify ?? true),
  );
}

describe('JobsAggregator — career level (Spec 1730)', () => {
  it('attaches careerLevel to every job after dedup (engine path)', async () => {
    const raw = [...sampleJobs(), job('1b', 'Software Engineer Intern', { site: Site.INDEED })];
    const out = await aggregator({ engine: titleEngine() }).aggregateRaw(raw);

    expect(out.deduped).toBe(true);
    expect(out.jobs).toHaveLength(6); // the duplicate intern posting collapsed
    expect(out.jobs.map((j) => j.careerLevel?.level)).toEqual([
      'internship',
      'new_grad',
      'senior',
      'manager',
      'unknown',
      'internship',
    ]);
    for (const j of out.jobs) {
      expect(j.careerLevel).toEqual({
        level: expect.any(String),
        confidence: expect.stringMatching(/^(high|medium|low)$/),
        reasons: expect.any(Array),
      });
    }
  });

  it('classifies on the dedup=false and no-engine paths too, keeping the pass-through array', async () => {
    const raw = sampleJobs();
    const optedOut = await aggregator({ engine: titleEngine() }).aggregateRaw(raw, { dedup: false });
    expect(optedOut.jobs).toBe(raw);
    expect(optedOut.jobs.every((j) => j.careerLevel)).toBe(true);

    const raw2 = sampleJobs();
    const noEngine = await aggregator().aggregateRaw(raw2);
    expect(noEngine.jobs).toBe(raw2);
    expect(noEngine.jobs.every((j) => j.careerLevel)).toBe(true);
  });

  it('EVER_JOBS_CLASSIFY_CAREER_LEVEL=false → careerLevel is absent', async () => {
    const out = await aggregator({ engine: titleEngine(), classify: false }).aggregateRaw(sampleJobs());
    expect(out.jobs).toHaveLength(6);
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
    expect(out.careerLevelFilteredOut).toBeUndefined();
  });

  it('careerLevels keeps only matching jobs and reports what it removed', async () => {
    const out = await aggregator({ engine: titleEngine() }).aggregateRaw(sampleJobs(), {
      careerLevels: ['internship', 'new_grad'],
    });
    expect(out.jobs.map((j) => j.id)).toEqual(['1', '2', '6']);
    expect(out.outputCount).toBe(3);
    expect(out.careerLevelFilteredOut).toBe(3);
    expect(out.rawCount).toBe(6);
  });

  it('the filter never mutates the raw (cached) array', async () => {
    const raw = sampleJobs();
    const before = [...raw];
    const out = await aggregator().aggregateRaw(raw, { dedup: false, careerLevels: ['senior'] });
    expect(out.jobs.map((j) => j.id)).toEqual(['3']);
    expect(out.jobs).not.toBe(raw);
    expect(raw).toEqual(before);
    expect(raw).toHaveLength(6);
  });

  it('an empty or unknown-only filter is no filter', async () => {
    const out = await aggregator().aggregateRaw(sampleJobs(), { careerLevels: [] });
    expect(out.jobs).toHaveLength(6);
    expect(out.careerLevelFilteredOut).toBeUndefined();
    const out2 = await aggregator().aggregateRaw(sampleJobs(), { careerLevels: ['junior'] });
    expect(out2.jobs).toHaveLength(6);
  });

  it('with the toggle off an explicit filter is still honoured, without attaching the field (Q-106)', async () => {
    const out = await aggregator({ classify: false }).aggregateRaw(sampleJobs(), { careerLevels: ['manager'] });
    expect(out.jobs.map((j) => j.id)).toEqual(['4']);
    expect(out.jobs[0]!.careerLevel).toBeUndefined();
  });

  it('never mutates the source jobType / jobLevel', async () => {
    const raw = sampleJobs();
    await aggregator().aggregateRaw(raw);
    expect(raw[5]!.jobType).toEqual([JobType.INTERNSHIP]);
    expect(raw[5]!.jobLevel).toBe('Internship');
    expect(raw[2]!.jobLevel).toBeUndefined();
  });

  it('aggregate() reads careerLevels from the input', async () => {
    (jobsService.searchJobs as jest.Mock).mockResolvedValueOnce(sampleJobs());
    const out = await aggregator().aggregate(new ScraperInputDto({ careerLevels: ['unknown'] }));
    expect(out.jobs.map((j) => j.id)).toEqual(['5']);
  });

  const broken: ICareerLevelClassifier = {
    classify: () => {
      throw new Error('boom');
    },
    classifyBatch: () => {
      throw new Error('boom');
    },
  };

  it('a throwing classifier without a filter degrades to unclassified jobs', async () => {
    const out = await aggregator({ classifier: broken }).aggregateRaw(sampleJobs());
    expect(out.jobs).toHaveLength(6);
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
  });

  it('a throwing classifier with a careerLevels filter fails closed with 503, never unfiltered (Q-106)', async () => {
    const pending = aggregator({ classifier: broken }).aggregateRaw(sampleJobs(), { careerLevels: ['senior'] });
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(pending).rejects.toThrow(/careerLevels filter could not be applied/);
  });

  it('a classifier that returns the wrong number of verdicts is a failure, not a silent partial', async () => {
    const short: ICareerLevelClassifier = {
      classify: (i) => classifier.classify(i),
      classifyBatch: (inputs) => classifier.classifyBatch(inputs).slice(1),
    };
    const out = await aggregator({ classifier: short }).aggregateRaw(sampleJobs());
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
    await expect(
      aggregator({ classifier: short }).aggregateRaw(sampleJobs(), { careerLevels: ['senior'] }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('with no classifier bound and no filter, jobs pass through unchanged', async () => {
    const out = await aggregator({ classifier: null }).aggregateRaw(sampleJobs());
    expect(out.jobs).toHaveLength(6);
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
  });

  it('with no classifier bound, a careerLevels filter fails closed with 503 before dedup runs (Q-106)', async () => {
    const engine = titleEngine();
    await expect(
      aggregator({ classifier: null, engine }).aggregateRaw(sampleJobs(), { careerLevels: ['senior'] }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(engine.dedup).not.toHaveBeenCalled();
  });

  it('works with the real dedup engine: duplicates collapse, the survivor is classified', async () => {
    const raw = [
      job('a', 'Quantitative Trader Intern', { companyName: 'Acme Capital', site: Site.LINKEDIN }),
      job('b', 'Quantitative Trader Intern', { companyName: 'Acme Capital', site: Site.INDEED }),
      job('c', 'Senior Staff Engineer', { companyName: 'Other Co', site: Site.LINKEDIN }),
    ];
    const out = await aggregator({ engine: new DedupHybridService() }).aggregateRaw(raw);
    expect(out.jobs.map((j) => [j.id, j.careerLevel?.level])).toEqual([
      ['a', 'internship'],
      ['c', 'staff'],
    ]);
  });
});

/**
 * Event-loop liveness (Spec 1730, NFR-2). Classification runs right after dedup on the same thread
 * that answers `GET /health`; a synchronous pass over a keyword-less fan-out (~30,000 jobs, ~2–3 s,
 * 13 s under load) would starve the liveness probe exactly as the pre-fix dedup did (see
 * `dedup-hybrid/src/cooperative.ts`). The probe here is a self-rescheduling `setImmediate` chain —
 * what an inbound request needs in order to be served. A synchronous pass lets it tick zero times.
 */
describe('JobsAggregator — career level keeps the event loop responsive (Spec 1730, NFR-2)', () => {
  const MAX_STALL_MS = Number(process.env.CAREER_LEVEL_LOOP_MAX_STALL_MS ?? 250);

  async function probeDuring<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number; worstGapMs: number }> {
    let ticks = 0;
    let running = true;
    let last = Date.now();
    let worstGapMs = 0;
    const tick = (): void => {
      if (!running) return;
      const now = Date.now();
      worstGapMs = Math.max(worstGapMs, now - last);
      last = now;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    try {
      const result = await work();
      worstGapMs = Math.max(worstGapMs, Date.now() - last);
      return { result, ticks, worstGapMs };
    } finally {
      running = false;
    }
  }

  /** A deterministic slow classifier: ≥ 1 ms of synchronous CPU per job. */
  const slow: ICareerLevelClassifier = {
    classify: (input) => classifier.classify(input),
    classifyBatch: (inputs) =>
      inputs.map((input) => {
        const until = Date.now() + 1;
        while (Date.now() < until) {
          // busy-wait: simulates a loaded machine
        }
        return classifier.classify(input);
      }),
  };

  it('yields to the event loop while classifying a large batch (slow classifier)', async () => {
    const jobs = Array.from({ length: 300 }, (_, i) => job(`s${i}`, i % 2 ? 'Software Engineer Intern' : 'Staff Engineer'));
    const { result, ticks, worstGapMs } = await probeDuring(() =>
      aggregator({ classifier: slow }).aggregateRaw(jobs, { dedup: false }),
    );
    expect(result.jobs.every((j) => j.careerLevel)).toBe(true);
    expect(result.jobs.map((j) => j.careerLevel!.level)).toEqual(
      jobs.map((_, i) => (i % 2 ? 'internship' : 'staff')),
    );
    // ≥ 300 ms of classification under a 10 ms budget: a synchronous pass ticks 0 times.
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(worstGapMs).toBeLessThan(MAX_STALL_MS);
  });

  it('yields with the real classifier on a realistic batch and returns the same verdicts as a sync pass', async () => {
    const paragraph =
      'We are looking for an engineer to join our team. You will design, build and operate services ' +
      'used by millions of customers. Requirements: 3+ years of experience with TypeScript or Go. ';
    const description = paragraph.repeat(Math.ceil(3200 / paragraph.length));
    const titles = ['Software Engineer Intern', 'Senior Software Engineer', 'Director of Product', 'Barista', 'New Grad Analyst'];
    const jobs = Array.from({ length: 3000 }, (_, i) => job(`r${i}`, titles[i % titles.length]!, { description }));
    const expected = classifier.classifyBatch(jobs.map((j) => ({ title: j.title, description: j.description })));

    const { result, ticks } = await probeDuring(() => aggregator().aggregateRaw(jobs, { dedup: false }));

    expect(result.jobs.map((j) => j.careerLevel)).toEqual(expected);
    expect(ticks).toBeGreaterThan(0);
  });

  it('the filter path yields too', async () => {
    const jobs = Array.from({ length: 200 }, (_, i) => job(`f${i}`, i % 4 === 0 ? 'Marketing Intern' : 'Senior Accountant'));
    const { result, ticks } = await probeDuring(() =>
      aggregator({ classifier: slow }).aggregateRaw(jobs, { dedup: false, careerLevels: ['internship'] }),
    );
    expect(result.jobs).toHaveLength(50);
    expect(result.careerLevelFilteredOut).toBe(150);
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('JobsAggregator — career level through Nest DI + env config (Spec 1730)', () => {
  const ORIGINAL = process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL;
    else process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL = ORIGINAL;
  });

  async function build(): Promise<JobsAggregator> {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ load: [configuration], ignoreEnvFile: true }), CareerLevelClassifierModule],
      providers: [JobsAggregator, { provide: JobsService, useValue: jobsService }],
    }).compile();
    return moduleRef.get(JobsAggregator);
  }

  it('default (unset) → the bound classifier attaches careerLevel', async () => {
    delete process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL;
    const out = await (await build()).aggregateRaw(sampleJobs());
    expect(out.jobs.every((j) => j.careerLevel)).toBe(true);
  });

  it('EVER_JOBS_CLASSIFY_CAREER_LEVEL=false → absent', async () => {
    process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL = 'false';
    const out = await (await build()).aggregateRaw(sampleJobs());
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
  });
});

describe('JobsController → aggregator → classifier, end to end (Spec 1730)', () => {
  /** A cache stub; `hit` is what every `get` returns (`null` = a miss). */
  const mockCache = (hit: unknown = null) => ({
    get: jest.fn(async (_params: Record<string, unknown>) => hit),
    set: jest.fn(async (_params: Record<string, unknown>, _value?: unknown) => undefined),
  });

  function controller(
    jobs: JobPostDto[],
    opts: { cache?: ReturnType<typeof mockCache>; classifier?: ICareerLevelClassifier | null } = {},
  ) {
    const service = {
      searchJobsWithDiagnostics: jest.fn(async () => ({ jobs, perSource: [] })),
    } as unknown as JobsService;
    const cache = opts.cache ?? mockCache();
    const passConfig = { get: (_k: string, def?: unknown) => def } as unknown as ConfigService;
    const bound = opts.classifier === null ? undefined : (opts.classifier ?? classifier);
    const agg = new JobsAggregator(service, titleEngine(), undefined, undefined, bound, passConfig);
    return new JobsController(service, agg, {} as never, cache as never, passConfig);
  }

  it('keeps careerLevels out of the raw-fan-out cache key, so a filtered search reuses the cached fan-out', async () => {
    const cache = mockCache();
    await controller(sampleJobs(), { cache }).searchJobs(
      new ScraperInputDto({ searchTerm: 'engineer', careerLevels: ['internship'] }),
    );
    await controller(sampleJobs(), { cache }).searchJobs(new ScraperInputDto({ searchTerm: 'engineer' }));
    const filtered = cache.get.mock.calls[0]![0];
    const unfiltered = cache.get.mock.calls[1]![0];
    expect(filtered.careerLevels).toBeUndefined();
    expect(filtered.endpoint).toBe(SEARCH_CACHE_ENDPOINT);
    expect(filtered.searchTerm).toBe('engineer');
    expect(filtered).toEqual(unfiltered);
    expect(cache.set.mock.calls[0]![0]).toEqual(filtered);
  });

  it('a cache hit is filtered per request: the cached raw fan-out is never narrowed', async () => {
    const cached = sampleJobs();
    const cache = mockCache(cached);
    const early = (await controller([], { cache }).searchJobs(
      new ScraperInputDto({ careerLevels: ['internship'] }),
    )) as { count: number; cached: boolean };
    expect(early).toMatchObject({ count: 2, cached: true });
    const all = (await controller([], { cache }).searchJobs(new ScraperInputDto({}))) as { count: number };
    expect(all.count).toBe(6);
    expect(cached).toHaveLength(6);
  });

  it('a careerLevels filter with no classifier bound is a 503, never an unfiltered 200 (Q-106)', async () => {
    await expect(
      controller(sampleJobs(), { classifier: null }).searchJobs(new ScraperInputDto({ careerLevels: ['internship'] })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const unfiltered = (await controller(sampleJobs(), { classifier: null }).searchJobs(
      new ScraperInputDto({}),
    )) as { count: number };
    expect(unfiltered.count).toBe(6);
  });

  it('JSON: every job carries careerLevel; careerLevels in the body filters', async () => {
    const all = (await controller(sampleJobs()).searchJobs(new ScraperInputDto({}))) as { count: number; jobs: JobPostDto[] };
    expect(all.count).toBe(6);
    expect(all.jobs.every((j) => j.careerLevel)).toBe(true);

    const early = (await controller(sampleJobs()).searchJobs(
      new ScraperInputDto({ careerLevels: ['internship', 'new_grad'] }),
    )) as { count: number; jobs: JobPostDto[] };
    expect(early.count).toBe(3);
    expect(early.jobs.map((j) => j.careerLevel?.level)).toEqual(['internship', 'new_grad', 'internship']);
  });

  it('CSV: the existing flattener emits careerLevel.* columns without format-specific code', async () => {
    const res = { setHeader: jest.fn() };
    const file = (await controller(sampleJobs()).searchJobs(
      new ScraperInputDto({}),
      'csv',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      res as never,
    )) as { getStream: () => NodeJS.ReadableStream };
    const chunks: Buffer[] = [];
    for await (const c of file.getStream() as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const csv = Buffer.concat(chunks).toString('utf-8');
    const header = csv.split('\n')[0]!.split(',');
    expect(header).toEqual(expect.arrayContaining(['careerLevel.level', 'careerLevel.confidence', 'careerLevel.reasons']));
    expect(csv).toContain('internship');
  });
});
