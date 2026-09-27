import 'reflect-metadata';
import {
  CanonicalJob,
  DedupResult,
  ExclusionPreset,
  IDedupEngine,
  IJobStore,
  JobPostDto,
  Site,
} from '@ever-jobs/models';
import { compileJobExclusions } from '@ever-jobs/common';
import { ERR_EXCLUSION_FAILED, JobsAggregator } from '../jobs.aggregator';

/** Spec 1700 — exclusion filters in `JobsAggregator.aggregateRaw`. */

function makeJob(id: string, title: string, description?: string): JobPostDto {
  return new JobPostDto({
    id,
    title,
    description,
    companyName: 'Acme',
    jobUrl: `https://example.com/job/${id}`,
    site: Site.LINKEDIN,
  });
}

const jobsService = { searchJobs: jest.fn() } as any;

/** Stub engine: `assignments[i]` is the cluster of raw row i (`null` = rejected). */
function makeEngine(assignments: (string | null)[]): IDedupEngine {
  return {
    dedup: jest.fn(async (jobs: ReadonlyArray<JobPostDto>) => {
      const ids = [...new Set(assignments.filter((a): a is string => !!a))];
      const result: DedupResult = {
        canonical: ids.map((canonicalJobId) => ({ canonicalJobId }) as unknown as CanonicalJob),
        assignments,
        errors: [],
        metrics: { inputCount: jobs.length, outputCount: ids.length, mergedPairs: 0, elapsedMs: 1 },
      };
      return result;
    }),
  };
}

function makeStore(): IJobStore & { upsertMany: jest.Mock } {
  return {
    upsert: jest.fn(),
    upsertMany: jest.fn(async () => ({ inserted: 0, updated: 0 })),
    getById: jest.fn(),
    findByCanonicalId: jest.fn(),
    listByQuery: jest.fn(),
    delete: jest.fn(),
  } as unknown as IJobStore & { upsertMany: jest.Mock };
}

const rows = () => [
  makeJob('1', 'Senior Engineer'),
  makeJob('2', 'Engineer'),
  makeJob('3', 'Analyst', 'Requires an active TS/SCI clearance.'),
  makeJob('4', 'Designer'),
];

describe('JobsAggregator — exclusions (Spec 1700)', () => {
  describe('pass-through paths', () => {
    it.each([
      ['no engine bound', () => new JobsAggregator(jobsService), {}],
      ['dedup=false', () => new JobsAggregator(jobsService, makeEngine(['a', 'b', 'c', 'd'])), { dedup: false }],
    ])('%s drops matching rows and reports metrics', async (_label, build, opts) => {
      const out = await build().aggregateRaw(rows(), {
        careerLevels: undefined,
        ...opts,
        exclusions: { titleTerms: ['senior'], presets: [ExclusionPreset.SECURITY_CLEARANCE] },
      });

      expect(out.jobs.map((j) => j.id)).toEqual(['2', '4']);
      expect(out.rawCount).toBe(4);
      expect(out.outputCount).toBe(2);
      expect(out.exclusionMetrics).toEqual({
        excludedCount: 2,
        excludedRawCount: 2,
        byTerm: [
          { term: 'senior', source: 'title_terms', count: 1 },
          { term: 'ts sci', source: 'preset:security_clearance', count: 1 },
        ],
        ignoredTerms: [],
      });
      expect(out.excludedSamples?.map((s) => [s.job.id, s.match.field])).toEqual([
        ['1', 'title'],
        ['3', 'description'],
      ]);
    });
  });

  describe('dedup path', () => {
    it('drops the whole cluster when any member matches', async () => {
      // Row 0 is the clean representative; row 1 (same cluster) mentions TS/SCI.
      const jobs = [
        makeJob('a', 'Systems Engineer', ''),
        makeJob('b', 'Systems Engineer', 'Active TS/SCI required.'),
        makeJob('c', 'Designer'),
      ];
      const aggregator = new JobsAggregator(jobsService, makeEngine(['c1', 'c1', 'c2']));

      const out = await aggregator.aggregateRaw(jobs, {
        careerLevels: undefined,
        exclusions: { presets: [ExclusionPreset.SECURITY_CLEARANCE] },
      });

      expect(out.jobs.map((j) => j.id)).toEqual(['c']);
      expect(out.outputCount).toBe(1);
      expect(out.exclusionMetrics?.excludedCount).toBe(1);
      expect(out.exclusionMetrics?.excludedRawCount).toBe(1);
      expect(out.rawCount).toBe(3);
    });

    it('persists every canonical record, including the excluded cluster', async () => {
      const store = makeStore();
      const aggregator = new JobsAggregator(jobsService, makeEngine(['c1', 'c2']), store);

      const out = await aggregator.aggregateRaw([makeJob('a', 'Senior Engineer'), makeJob('b', 'Engineer')], {
        careerLevels: undefined,
        exclusions: { titleTerms: ['senior'] },
      });

      expect(out.jobs.map((j) => j.id)).toEqual(['b']);
      expect(store.upsertMany).toHaveBeenCalledTimes(1);
      expect((store.upsertMany.mock.calls[0][0] as CanonicalJob[]).map((c) => c.canonicalJobId)).toEqual([
        'c1',
        'c2',
      ]);
    });

    it('an engine-rejected matching row counts only in excludedRawCount', async () => {
      const aggregator = new JobsAggregator(jobsService, makeEngine([null, 'c1']));

      const out = await aggregator.aggregateRaw([makeJob('a', 'Senior Engineer'), makeJob('b', 'Engineer')], {
        careerLevels: undefined,
        exclusions: { titleTerms: ['senior'] },
      });

      expect(out.jobs.map((j) => j.id)).toEqual(['b']);
      expect(out.exclusionMetrics).toMatchObject({ excludedCount: 0, excludedRawCount: 1 });
    });

    it('returns zeroed metrics on the empty path', async () => {
      const aggregator = new JobsAggregator(jobsService, makeEngine([]));

      const out = await aggregator.aggregateRaw([], { careerLevels: undefined, exclusions: { titleTerms: ['senior'] } });

      expect(out.exclusionMetrics).toMatchObject({ excludedCount: 0, excludedRawCount: 0 });
    });
  });

  describe('unchanged without exclusions', () => {
    it.each([
      ['no engine', () => new JobsAggregator(jobsService), {}],
      ['dedup=false', () => new JobsAggregator(jobsService, makeEngine(['a', 'b', 'c', 'd'])), { dedup: false }],
      ['dedup', () => new JobsAggregator(jobsService, makeEngine(['a', 'b', 'c', 'd'])), {}],
    ])('%s: no exclusion keys when the option is absent', async (_label, build, opts) => {
      const out = await build().aggregateRaw(rows(), { careerLevels: undefined, ...opts });
      expect(out).not.toHaveProperty('exclusionMetrics');
      expect(out).not.toHaveProperty('excludedSamples');
      expect(out).not.toHaveProperty('exclusionError');
      expect(out.jobs).toHaveLength(4);
    });

    it('an inactive spec removes nothing but still reports (zeroed) metrics', async () => {
      const input = rows();
      const out = await new JobsAggregator(jobsService).aggregateRaw(input, {
        careerLevels: undefined,
        exclusions: { titleTerms: ['   ', 'a*'] },
      });

      expect(out.jobs).toBe(input);
      expect(out.exclusionMetrics).toEqual({
        excludedCount: 0,
        excludedRawCount: 0,
        byTerm: [],
        ignoredTerms: [
          { term: '   ', reason: 'empty' },
          { term: 'a*', reason: 'prefix_too_short' },
        ],
      });
    });

    it('accepts a pre-compiled spec', async () => {
      const out = await new JobsAggregator(jobsService).aggregateRaw(rows(), {
        careerLevels: undefined,
        exclusions: compileJobExclusions({ titleTerms: ['designer'] }),
      });
      expect(out.jobs.map((j) => j.id)).toEqual(['1', '2', '3']);
    });
  });

  it('serves the unfiltered list with exclusionError when the filter throws', async () => {
    const hostile = {
      get titleTerms(): string[] {
        throw new Error('boom');
      },
    };
    const input = rows();
    const out = await new JobsAggregator(jobsService).aggregateRaw(input, { careerLevels: undefined, exclusions: hostile });
    expect(out.jobs).toBe(input);
    expect(out.exclusionError).toEqual({ code: ERR_EXCLUSION_FAILED, message: 'boom' });
    expect(out.exclusionMetrics).toBeUndefined();
  });
});
