import 'reflect-metadata';
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

  it('a throwing classifier degrades to unclassified, unfiltered jobs', async () => {
    const broken: ICareerLevelClassifier = {
      classify: () => {
        throw new Error('boom');
      },
      classifyBatch: () => {
        throw new Error('boom');
      },
    };
    const out = await aggregator({ classifier: broken }).aggregateRaw(sampleJobs(), { careerLevels: ['senior'] });
    expect(out.jobs).toHaveLength(6);
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
  });

  it('with no classifier bound, jobs pass through unchanged', async () => {
    const out = await aggregator({ classifier: null }).aggregateRaw(sampleJobs(), { careerLevels: ['senior'] });
    expect(out.jobs).toHaveLength(6);
    expect(out.jobs.every((j) => j.careerLevel === undefined)).toBe(true);
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
  function controller(jobs: JobPostDto[]) {
    const service = {
      searchJobsWithDiagnostics: jest.fn(async () => ({ jobs, perSource: [] })),
    } as unknown as JobsService;
    const cache = { get: async () => null, set: async () => undefined };
    const passConfig = { get: (_k: string, def?: unknown) => def } as unknown as ConfigService;
    const agg = new JobsAggregator(service, titleEngine(), undefined, undefined, classifier, passConfig);
    return new JobsController(service, agg, {} as never, cache as never, passConfig);
  }

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
