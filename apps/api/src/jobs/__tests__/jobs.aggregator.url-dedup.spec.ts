import 'reflect-metadata';
import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { DEDUP_BY_URL_ENV, JobsAggregator } from '../jobs.aggregator';

/** Spec 1754 — canonical-URL skip pass in the aggregator (default off). */

function job(
  id: string,
  jobUrl: string,
  overrides: Partial<JobPostDto> & { city?: string } = {},
): JobPostDto {
  const { city = 'Austin', ...rest } = overrides;
  return new JobPostDto({
    id,
    site: Site.LINKEDIN,
    title: 'Backend Engineer',
    companyName: id.startsWith('z') ? 'Zeta Ltd' : 'Acme Corp',
    jobUrl,
    location: new LocationDto({ city, state: 'TX' }),
    ...rest,
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
    job('a2', 'https://example.com/jobs/1?utm_medium=mail'),
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

  it('keeps the same title in two cities that share one listing URL', async () => {
    const shared = 'https://example.com/careers';
    const result = await new JobsAggregator(jobsService).aggregateRaw(
      [job('a1', shared, { city: 'Austin' }), job('a2', shared, { city: 'Berlin' }), job('a3', `${shared}?utm_source=x`, { city: 'Austin' })],
      { ...opts, dedupByUrl: true },
    );
    expect(result.jobs.map((j) => j.id)).toEqual(['a1', 'a2']);
    expect(result.urlDuplicatesSkipped).toBe(1);
  });

  it('keeps the same title at two companies that share one listing URL', async () => {
    const shared = 'https://example.com/careers';
    const result = await new JobsAggregator(jobsService).aggregateRaw(
      [job('a1', shared), job('z2', shared)],
      { ...opts, dedupByUrl: true },
    );
    expect(result.jobs).toHaveLength(2);
    expect(result.urlDuplicatesSkipped).toBeUndefined();
  });

  it('never hides a duplicate the exclusion filter matches', async () => {
    // a1 is clean, a2 (same link) mentions the excluded term in its description.
    const rows = [
      job('a1', 'https://example.com/jobs/1', { description: 'Great team.' }),
      job('a2', 'https://example.com/jobs/1?utm_source=x', { description: 'Requires an active clearance.' }),
    ];
    const withSkip = await new JobsAggregator(jobsService).aggregateRaw(rows, {
      ...opts,
      dedupByUrl: true,
      exclusions: { keywords: ['clearance'] },
    });
    const without = await new JobsAggregator(jobsService).aggregateRaw(rows, {
      ...opts,
      exclusions: { keywords: ['clearance'] },
    });
    // Same outcome as without the URL pass: the matching row is excluded, nothing is lost silently.
    expect(withSkip.jobs.map((j) => j.id)).toEqual(without.jobs.map((j) => j.id));
    expect(withSkip.exclusionMetrics?.excludedRawCount).toBe(without.exclusionMetrics?.excludedRawCount);
    expect(withSkip.urlDuplicatesSkipped).toBeUndefined();
  });
});
