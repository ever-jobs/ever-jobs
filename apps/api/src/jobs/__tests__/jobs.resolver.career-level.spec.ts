import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { CareerLevelClassifierService } from '@ever-jobs/career-level-classifier';
import { JobPostDto } from '@ever-jobs/models';

import { SearchJobsInput } from '../gql-types';
import { JobsAggregator } from '../jobs.aggregator';
import { JobsResolver } from '../jobs.resolver';

/** Spec 1730 — GraphQL: `careerLevel` on output, `careerLevels` filter on input. */
function setup(jobs: JobPostDto[]) {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
  const cacheService = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (_k: string, def?: unknown) => def };
  const aggregator = new JobsAggregator(
    jobsService as never,
    undefined,
    undefined,
    undefined,
    new CareerLevelClassifierService(),
    config as never,
  );
  const aggregateRaw = jest.spyOn(aggregator, 'aggregateRaw');
  const resolver = new JobsResolver(jobsService as never, aggregator, cacheService as never, config as never);
  return { resolver, aggregateRaw, cacheService };
}

const jobs = () => [
  new JobPostDto({ id: '1', title: 'Data Science Intern', jobUrl: 'https://example.com/1' }),
  new JobPostDto({ id: '2', title: 'Principal Engineer', jobUrl: 'https://example.com/2' }),
];

function input(extra: Partial<SearchJobsInput> = {}): SearchJobsInput {
  return Object.assign(new SearchJobsInput(), { searchTerm: 'engineer', ...extra });
}

describe('JobsResolver — career level (Spec 1730)', () => {
  it('returns careerLevel on every job', async () => {
    const { resolver } = setup(jobs());
    const out = await resolver.searchJobs(input());
    expect(out.jobs.map((j) => j.careerLevel?.level)).toEqual(['internship', 'principal']);
  });

  it('passes careerLevels to the aggregator and counts post-filter', async () => {
    const { resolver, aggregateRaw } = setup(jobs());
    const out = await resolver.searchJobs(input({ careerLevels: ['principal'] }));
    expect(aggregateRaw).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ careerLevels: ['principal'] }));
    expect(out.count).toBe(1);
    expect(out.jobs[0]!.careerLevel?.level).toBe('principal');
  });

  it('rejects an unknown level before scraping', async () => {
    const { resolver, cacheService } = setup(jobs());
    await expect(resolver.searchJobs(input({ careerLevels: ['intern'] }))).rejects.toBeInstanceOf(BadRequestException);
    expect(cacheService.get).not.toHaveBeenCalled();
  });

  it('keeps careerLevels out of the raw-fan-out cache key', async () => {
    const { resolver, cacheService } = setup(jobs());
    await resolver.searchJobs(input({ careerLevels: ['principal'] }));
    const params = cacheService.get.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.careerLevels).toBeUndefined();
    expect(params.endpoint).toBe('graphql-search-v2');
  });
});
