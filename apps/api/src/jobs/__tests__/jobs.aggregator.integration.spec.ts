/**
 * Integration test — JobsAggregator wired to the real DedupHybridService.
 *
 * Spec 003 / T13 acceptance: "Multi-source response is deduped; dedup=false
 * opt-out works." This test feeds a small mixed batch (3 fake sources, 2
 * logical jobs) through the aggregator and asserts:
 *
 *   1. Same logical job from 3 sources collapses to 1 record by default.
 *   2. `dedup=false` returns all 3 raw observations untouched.
 *   3. Genuinely different jobs are kept separate.
 *   4. The representative picked is the first input in the cluster
 *      (preserving the JobsService sort order).
 */
import 'reflect-metadata';
import { JobPostDto, ScraperInputDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { JobsAggregator } from '../jobs.aggregator';

function makeJob(
  id: string,
  site: Site,
  overrides: Partial<JobPostDto> = {},
): JobPostDto {
  return new JobPostDto({
    id,
    title: overrides.title ?? 'Senior Software Engineer',
    companyName: overrides.companyName ?? 'Acme Corp',
    jobUrl: overrides.jobUrl ?? `https://example.com/${site}/${id}`,
    site,
    description: overrides.description,
    isRemote: overrides.isRemote ?? false,
  });
}

describe('JobsAggregator — integration with DedupHybridService', () => {
  const engine = new DedupHybridService();

  it('default dedup=true collapses identical jobs from 3 sources into 1', async () => {
    // Three sources surface the same role; one different role surfaces twice.
    const rawJobs: JobPostDto[] = [
      makeJob('a-li', Site.LINKEDIN, { title: 'Senior Software Engineer', companyName: 'Acme Corp' }),
      makeJob('a-in', Site.INDEED, { title: 'Senior Software Engineer', companyName: 'Acme Corp' }),
      makeJob('a-gh', Site.GREENHOUSE, { title: 'Senior Software Engineer', companyName: 'Acme Corp' }),
      makeJob('b-li', Site.LINKEDIN, { title: 'Product Manager', companyName: 'Other Co' }),
      makeJob('b-in', Site.INDEED, { title: 'Product Manager', companyName: 'Other Co' }),
    ];

    const jobsService = { searchJobs: jest.fn().mockResolvedValue(rawJobs) } as any;
    const aggregator = new JobsAggregator(jobsService, engine);

    const out = await aggregator.aggregateRaw(rawJobs);

    expect(out.deduped).toBe(true);
    expect(out.rawCount).toBe(5);
    expect(out.outputCount).toBe(2);
    expect(out.jobs.map((j) => j.id)).toEqual(['a-li', 'b-li']);
    expect(out.dedupMetrics?.mergedPairs).toBe(3);
  });

  it('dedup=false returns all raw observations untouched', async () => {
    const rawJobs: JobPostDto[] = [
      makeJob('a-li', Site.LINKEDIN, { title: 'Senior Software Engineer' }),
      makeJob('a-in', Site.INDEED, { title: 'Senior Software Engineer' }),
      makeJob('a-gh', Site.GREENHOUSE, { title: 'Senior Software Engineer' }),
    ];
    const jobsService = { searchJobs: jest.fn().mockResolvedValue(rawJobs) } as any;
    const aggregator = new JobsAggregator(jobsService, engine);

    const out = await aggregator.aggregateRaw(rawJobs, { dedup: false, careerLevels: undefined });

    expect(out.deduped).toBe(false);
    expect(out.outputCount).toBe(3);
    expect(out.jobs).toBe(rawJobs); // identity preserved
    expect(out.dedupMetrics).toBeUndefined();
  });

  it('keeps cosmetic-different but logically-same jobs together', async () => {
    // Same canonical key but different cosmetic title casing / suffix.
    const rawJobs: JobPostDto[] = [
      makeJob('a1', Site.LINKEDIN, { title: 'Senior Software Engineer', companyName: 'Acme, Inc.' }),
      makeJob('a2', Site.INDEED, { title: 'senior software engineer', companyName: 'ACME Inc' }),
      makeJob('a3', Site.GREENHOUSE, { title: 'Senior Software Engineer', companyName: 'Acme' }),
    ];
    const jobsService = { searchJobs: jest.fn().mockResolvedValue(rawJobs) } as any;
    const aggregator = new JobsAggregator(jobsService, engine);

    const out = await aggregator.aggregateRaw(rawJobs);

    expect(out.outputCount).toBe(1);
    expect(out.jobs[0].id).toBe('a1');
  });

  it('end-to-end via aggregate(input)', async () => {
    const rawJobs: JobPostDto[] = [
      makeJob('a-li', Site.LINKEDIN),
      makeJob('a-in', Site.INDEED),
    ];
    const jobsService = { searchJobs: jest.fn().mockResolvedValue(rawJobs) } as any;
    const aggregator = new JobsAggregator(jobsService, engine);

    const out = await aggregator.aggregate(new ScraperInputDto({ searchTerm: 'swe' }));

    expect(jobsService.searchJobs).toHaveBeenCalledTimes(1);
    expect(out.deduped).toBe(true);
    expect(out.outputCount).toBe(1);
  });
});
