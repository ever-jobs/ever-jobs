import 'reflect-metadata';
import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { dedupKeyForJob } from '@ever-jobs/common';
import { JobsAggregator, stampDedupKeys } from '../jobs.aggregator';

/**
 * Spec 1721 / contract C9 — every job the aggregator returns carries a stable
 * `dedupKey`, on every path (dedup on, dedup off, no engine, empty), and it is
 * the key the real dedup engine clusters on.
 */

function job(id: string, site: Site, overrides: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id,
    site,
    title: 'Senior Software Engineer',
    companyName: 'Acme Corp',
    jobUrl: `https://example.com/${site}/${id}`,
    location: new LocationDto({ city: 'Austin', state: 'TX' }),
    ...overrides,
  });
}

const jobsService = { searchJobs: jest.fn() } as any;

describe('JobsAggregator — dedupKey (Spec 1721)', () => {
  it('dedup=true: the same posting from two sources collapses and carries the engine key', async () => {
    const engine = new DedupHybridService();
    const aggregator = new JobsAggregator(jobsService, engine);
    const raw = [
      job('li-1', Site.LINKEDIN),
      job('gh-9', Site.GREENHOUSE, { title: 'Sr. Software Engineer', companyName: 'ACME CORP' }),
      job('li-2', Site.LINKEDIN, { title: 'Product Manager' }),
    ];

    const engineResult = await engine.dedup(raw);
    const result = await aggregator.aggregateRaw(raw, { dedup: true, persist: false });

    expect(result.jobs).toHaveLength(2);
    for (const out of result.jobs) {
      expect(out.dedupKey).toMatch(/^[0-9a-f]{64}$/);
      // The key equals the cluster id the engine assigned to that job.
      const index = raw.indexOf(out);
      expect(out.dedupKey).toBe(engineResult.assignments[index]);
    }
    // And both sources' views of the SWE role hash to it.
    expect(dedupKeyForJob(raw[1]!)).toBe(result.jobs[0]!.dedupKey);
  });

  it('dedup=false: every raw observation carries its key; duplicates share it', async () => {
    const aggregator = new JobsAggregator(jobsService, new DedupHybridService());
    const raw = [job('li-1', Site.LINKEDIN), job('in-1', Site.INDEED), job('li-2', Site.LINKEDIN, { title: 'PM' })];

    const result = await aggregator.aggregateRaw(raw, { dedup: false });

    expect(result.deduped).toBe(false);
    expect(result.jobs.map((j) => j.dedupKey)).toEqual([
      raw[0]!.dedupKey,
      raw[0]!.dedupKey,
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(result.jobs[2]!.dedupKey).not.toBe(result.jobs[0]!.dedupKey);
  });

  it('no engine bound: keys are still stamped', async () => {
    const aggregator = new JobsAggregator(jobsService);
    const result = await aggregator.aggregateRaw([job('a', Site.LINKEDIN)]);
    expect(result.jobs[0]!.dedupKey).toBe(dedupKeyForJob(result.jobs[0]!));
  });

  it('the same posting on a later run (cache round-trip, new ids) gets the same key', async () => {
    const aggregator = new JobsAggregator(jobsService, new DedupHybridService());
    const first = await aggregator.aggregateRaw([job('run1', Site.LINKEDIN)], { persist: false });
    const replay = JSON.parse(JSON.stringify([job('run2', Site.INDEED)])) as JobPostDto[];
    const second = await aggregator.aggregateRaw(replay, { persist: false });
    expect(second.jobs[0]!.dedupKey).toBe(first.jobs[0]!.dedupKey);
  });

  it('stampDedupKeys yields on large inputs and keys every job', async () => {
    const many = Array.from({ length: 1_250 }, (_, i) => job(`j${i}`, Site.LINKEDIN, { title: `Role ${i}` }));
    await stampDedupKeys(many);
    expect(many.every((j) => typeof j.dedupKey === 'string')).toBe(true);
    expect(new Set(many.map((j) => j.dedupKey)).size).toBe(1_250);
  });
});
