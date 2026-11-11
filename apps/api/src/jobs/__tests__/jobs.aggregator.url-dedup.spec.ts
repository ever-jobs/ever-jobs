import 'reflect-metadata';
import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { DEDUP_BY_URL_ENV, JobsAggregator } from '../jobs.aggregator';

/** Spec 1754 — canonical-URL skip pass in the aggregator (default off). */

function job(id: string, jobUrl: string, title = 'Backend Engineer'): JobPostDto {
  return new JobPostDto({
    id,
    site: Site.LINKEDIN,
    title,
    companyName: id.startsWith('z') ? 'Zeta Ltd' : 'Acme Corp',
    jobUrl,
    location: new LocationDto({ city: 'Austin', state: 'TX' }),
  });
}

const jobsService = { searchJobs: jest.fn() } as any;
const opts = { dedup: false, persist: false, careerLevels: undefined } as const;

describe('JobsAggregator — url dedup (Spec 1754)', () => {
  const saved = process.env[DEDUP_BY_URL_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[DEDUP_BY_URL_ENV];
    else process.env[DEDUP_BY_URL_ENV] = saved;
  });

  const raw = () => [
    job('a1', 'https://Example.com/jobs/1?utm_source=feed'),
    job('z2', 'https://example.com/jobs/1?utm_medium=mail'),
    job('z3', 'https://example.com/jobs/3'),
  ];

  it('is off by default: nothing is skipped', async () => {
    delete process.env[DEDUP_BY_URL_ENV];
    const result = await new JobsAggregator(jobsService).aggregateRaw(raw(), opts);
    expect(result.jobs).toHaveLength(3);
    expect(result.urlDuplicatesSkipped).toBeUndefined();
  });

  it('dedupByUrl=true keeps the first posting and reports the skip', async () => {
    const result = await new JobsAggregator(jobsService).aggregateRaw(raw(), { ...opts, dedupByUrl: true });
    expect(result.jobs.map((j) => j.id)).toEqual(['a1', 'z3']);
    expect(result.rawCount).toBe(3);
    expect(result.outputCount).toBe(2);
    expect(result.urlDuplicatesSkipped).toBe(1);
  });

  it('the env switch turns it on, and an explicit false turns it off again', async () => {
    process.env[DEDUP_BY_URL_ENV] = 'true';
    const aggregator = new JobsAggregator(jobsService);
    expect((await aggregator.aggregateRaw(raw(), opts)).jobs).toHaveLength(2);
    expect((await aggregator.aggregateRaw(raw(), { ...opts, dedupByUrl: false })).jobs).toHaveLength(3);
  });

  it('runs ahead of the dedup engine and its keys still line up', async () => {
    const aggregator = new JobsAggregator(jobsService, new DedupHybridService());
    const result = await aggregator.aggregateRaw(raw(), { ...opts, dedup: true, dedupByUrl: true });
    expect(result.rawCount).toBe(3);
    expect(result.urlDuplicatesSkipped).toBe(1);
    expect(result.jobs.map((j) => j.id)).toEqual(['a1', 'z3']);
    for (const out of result.jobs) expect(out.dedupKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
