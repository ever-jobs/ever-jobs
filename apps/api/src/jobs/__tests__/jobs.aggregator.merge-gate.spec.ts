import 'reflect-metadata';
import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '@ever-jobs/dedup-hybrid';
import { dedupKeyForJob } from '@ever-jobs/common';
import { JobsAggregator } from '../jobs.aggregator';

/**
 * Spec 1724 — what the aggregator returns once the dedup engine keeps
 * incompatible postings apart: the kept job of a merged cluster carries the
 * cluster's union of locations, and postings the engine kept apart never
 * share a `dedupKey`.
 */

const DESCRIPTION =
  'Join the team that designs and runs the systems behind our global trading. ' +
  'You will partner with researchers, own services from design to production, and review code across the firm. ' +
  'We value curiosity, careful engineering and clear communication above any particular stack.';

const NEW_YORK = new LocationDto({ city: 'New York', state: 'NY', country: 'United States' });
const LONDON = new LocationDto({ city: 'London', state: 'England', country: 'United Kingdom' });
const HONG_KONG = new LocationDto({ city: 'Hong Kong', country: 'Hong Kong SAR China' });

function job(id: string, overrides: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id,
    site: Site.GREENHOUSE,
    title: 'Cybersecurity Engineer',
    companyName: 'Acme Trading',
    jobUrl: `https://boards.example.com/acme/${id}`,
    description: DESCRIPTION,
    ...overrides,
  });
}

const jobsService = { searchJobs: jest.fn() } as any;

describe('JobsAggregator — merge gate (Spec 1724)', () => {
  it('returns one job per office and per program of a role posted per office', async () => {
    const engine = new DedupHybridService();
    const aggregator = new JobsAggregator(jobsService, engine);
    const raw = [
      job('hk-intern', { location: HONG_KONG, employmentType: 'Summer Internship' }),
      job('ny-intern', { location: NEW_YORK, employmentType: 'Summer Internship' }),
      job('ny-grad', { location: NEW_YORK, employmentType: 'Full-Time: New Grad' }),
      job('ldn', { location: LONDON, employmentType: 'Full-Time: Experienced' }),
    ];

    const engineResult = await engine.dedup(raw);
    const result = await aggregator.aggregateRaw(raw, { dedup: true, persist: false });

    expect(result.jobs.map((j) => j.id)).toEqual(['hk-intern', 'ny-intern', 'ny-grad', 'ldn']);
    // Every returned key is the engine's cluster id for that posting ...
    result.jobs.forEach((out, i) => expect(out.dedupKey).toBe(engineResult.assignments[i]));
    // ... so the New York internship and new-grad postings, whose title,
    // company and location coincide, do NOT share a key.
    expect(new Set(result.jobs.map((j) => j.dedupKey)).size).toBe(4);
  });

  it('dedup=false keeps the per-job key: the two New York postings share it (documented)', async () => {
    const aggregator = new JobsAggregator(jobsService, new DedupHybridService());
    const raw = [
      job('ny-intern', { location: NEW_YORK, employmentType: 'Summer Internship' }),
      job('ny-grad', { location: NEW_YORK, employmentType: 'Full-Time: New Grad' }),
    ];
    const result = await aggregator.aggregateRaw(raw, { dedup: false });
    expect(result.jobs[0]!.dedupKey).toBe(result.jobs[1]!.dedupKey);
  });

  it('the kept job of a merged cluster carries the union of locations, as a copy', async () => {
    const engine = new DedupHybridService();
    const aggregator = new JobsAggregator(jobsService, engine);
    // Input order puts the board listing (one office, flat location only)
    // first, so it is the representative; the ATS posting names both offices.
    const board = job('board', { site: Site.LINKEDIN, location: new LocationDto({ city: 'New York', state: 'NY' }) });
    const ats = job('ats', { location: NEW_YORK, locations: [NEW_YORK, LONDON] });
    const raw = [board, ats];
    const boardKey = dedupKeyForJob(board);

    const engineResult = await engine.dedup(raw);
    const result = await aggregator.aggregateRaw(raw, { dedup: true, persist: false });

    expect(result.jobs).toHaveLength(1);
    const kept = result.jobs[0]!;
    expect(kept.id).toBe('board');
    expect(kept.locations?.map((l) => l.city)).toEqual(['New York', 'London']);
    // The key is the representative's own (pre-union) key, i.e. the cluster id.
    expect(kept.dedupKey).toBe(boardKey);
    expect(kept.dedupKey).toBe(engineResult.assignments[0]);
    // The input (possibly the cached fan-out) is untouched.
    expect(kept).not.toBe(board);
    expect(board.locations).toBeUndefined();
  });

  it('a singleton or a merge that adds no site returns the raw job itself', async () => {
    const aggregator = new JobsAggregator(jobsService, new DedupHybridService());
    const a = job('a', { location: NEW_YORK, locations: [NEW_YORK] });
    const b = job('b', { site: Site.LINKEDIN, location: NEW_YORK });
    const result = await aggregator.aggregateRaw([a, b], { dedup: true, persist: false });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toBe(a);
    expect(a.dedupKey).toBe(dedupKeyForJob(a));
  });
});
