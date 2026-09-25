import { JobPostDto, JobType, LocationDto, Site } from '@ever-jobs/models';
import { dedupKeyForJob } from '@ever-jobs/common';
import { DedupHybridService } from '../src/dedup-hybrid.service';
import {
  employmentClassesOf,
  mergeProfileOf,
  profilesCompatible,
  siteSetsCompatible,
  sitesOf,
} from '../src/merge-gate';
import { HashStrategy } from '../src/strategies/hash-strategy';
import { MinHashStrategy } from '../src/strategies/minhash-strategy';
import { PreparedJob } from '../src/types';
import { UnionFind } from '../src/union-find';
import { JANE_STREET_LIST_MODE_ROWS } from './fixtures/janestreet-list-mode.fixture';

/**
 * Spec 1724 — the merge gate. Two postings are merged only when their
 * locations are compatible (same place, or one side names none, or one
 * multi-site posting covers the other) and their employment types do not
 * conflict; when merged, the canonical record keeps the union of locations.
 */

const DESCRIPTION =
  'We are hiring an engineer to design and operate the low-latency systems that run our trading. ' +
  'You will work with researchers and traders, own services end to end, and review code across teams. ' +
  'Strong programming skills and curiosity about markets are what matter most to us.';

function job(partial: Partial<JobPostDto>): JobPostDto {
  return new JobPostDto({
    title: 'Software Engineer',
    companyName: 'Acme Trading',
    jobUrl: `https://acme.example.com/jobs/${partial.id ?? 'x'}`,
    site: Site.GREENHOUSE,
    description: DESCRIPTION,
    ...partial,
  });
}

const NEW_YORK = new LocationDto({ city: 'New York', state: 'NY', country: 'United States' });
const LONDON = new LocationDto({ city: 'London', state: 'England', country: 'United Kingdom' });
const HONG_KONG = new LocationDto({ city: 'Hong Kong', country: 'Hong Kong SAR China' });

function janeStreetJobs(): JobPostDto[] {
  return JANE_STREET_LIST_MODE_ROWS.map(
    (row) =>
      new JobPostDto({
        ...row,
        location: row.location ? new LocationDto(row.location) : null,
        locations: row.locations.map((l) => new LocationDto(l)),
      }),
  );
}

describe('merge gate — Jane Street list-mode regression (Spec 1724)', () => {
  it('keeps all 30 postings of the captured crawl apart (was 30 -> 20)', async () => {
    const jobs = janeStreetJobs();
    expect(jobs).toHaveLength(30);

    const out = await new DedupHybridService().dedup(jobs);

    expect(out.errors).toHaveLength(0);
    expect(out.canonical).toHaveLength(30);
    expect(out.metrics.mergedPairs).toBe(0);
    expect(new Set(out.assignments).size).toBe(30);
  });

  it('control: the strategies DO propose cross-city and cross-program merges on this batch', () => {
    // Without this, the test above could pass because nothing was ever proposed.
    const jobs = janeStreetJobs();
    const prepared: PreparedJob[] = jobs.map((raw, index) => {
      const key = dedupKeyForJob(raw)!;
      return { index, raw, canonicalJobId: key, canonicalKey: key };
    });
    // What the engine did before the gate: union every proposal.
    const uf = new UnionFind(jobs.length);
    for (const c of [...new HashStrategy().cluster(prepared).clusters, ...new MinHashStrategy().cluster(prepared).clusters]) {
      for (const i of c) uf.union(c[0]!, i);
    }
    const proposed = uf.toClusters().filter((c) => c.length > 1);
    // 30 in, 20 out — the live defect, reproduced from the fixture.
    expect(uf.toClusters()).toHaveLength(20);

    const label = (i: number): string => `${jobs[i]!.location?.city ?? jobs[i]!.location?.country}|${jobs[i]!.employmentType}`;
    const spansCities = proposed.some((c) => new Set(c.map((i) => jobs[i]!.location?.city ?? '')).size > 1);
    const spansPrograms = proposed.some((c) => new Set(c.map((i) => jobs[i]!.employmentType)).size > 1);
    expect(spansCities).toBe(true);
    expect(spansPrograms).toBe(true);
    // The exact defect from the live crawl: New York "Full-Time: New Grad" was
    // proposed together with a Hong Kong "Summer Internship".
    expect(
      proposed.some((c) => {
        const d = c.map(label);
        return d.includes('New York|Full-Time: New Grad') && d.includes('Hong Kong|Summer Internship');
      }),
    ).toBe(true);
  });

  it('the two New York SOC postings (same title and city; internship vs new grad) get distinct ids', async () => {
    const jobs = janeStreetJobs();
    const soc = jobs
      .map((j, i) => ({ j, i }))
      .filter(({ j }) => j.title.startsWith('Cybersecurity Engineer - Security Operations Center') && j.location?.city === 'New York');
    expect(soc.map(({ j }) => j.employmentType).sort()).toEqual(['Full-Time: New Grad', 'Summer Internship']);
    // Same canonical key: the hash stage proposes them as one posting.
    expect(dedupKeyForJob(soc[0]!.j)).toBe(dedupKeyForJob(soc[1]!.j));

    const out = await new DedupHybridService().dedup(jobs);
    const [a, b] = soc.map(({ i }) => out.assignments[i]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    // Neither inherits the plain id both would have shared.
    expect([a, b]).not.toContain(dedupKeyForJob(soc[0]!.j));
    // Deterministic across runs.
    const again = await new DedupHybridService().dedup(janeStreetJobs());
    expect(soc.map(({ i }) => again.assignments[i])).toEqual([a, b]);
  });
});

describe('merge gate — location rule (Spec 1724)', () => {
  let service: DedupHybridService;
  beforeEach(() => {
    service = new DedupHybridService();
  });

  it('control: the same role in the same city, from two sources, still merges', async () => {
    const out = await service.dedup([
      job({ id: 'gh', location: NEW_YORK }),
      job({ id: 'li', site: Site.LINKEDIN, title: 'Software Engineer II', location: new LocationDto({ city: 'New York', state: 'NY' }) }),
    ]);
    expect(out.canonical).toHaveLength(1);
  });

  it('does not merge the same description posted in two different cities', async () => {
    const out = await service.dedup([job({ id: '1', location: NEW_YORK }), job({ id: '2', location: HONG_KONG })]);
    expect(out.canonical).toHaveLength(2);
    expect(out.assignments[0]).not.toBe(out.assignments[1]);
  });

  it('merges when one side names no location, and keeps the union of locations', async () => {
    const out = await service.dedup([
      job({ id: '1', site: Site.LINKEDIN }),
      job({ id: '2', location: NEW_YORK, locations: [NEW_YORK] }),
    ]);
    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0]!.locations?.map((l) => l.city)).toEqual(['New York']);
  });

  it('merges a board listing of one office into the multi-office ATS posting that covers it', async () => {
    const out = await service.dedup([
      job({ id: 'ats', location: NEW_YORK, locations: [NEW_YORK, LONDON] }),
      job({ id: 'board', site: Site.LINKEDIN, title: 'Software Engineer (London)', location: LONDON }),
    ]);
    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0]!.locations?.map((l) => l.city)).toEqual(['New York', 'London']);
  });

  it('a posting with no location cannot bridge two cities into one cluster', async () => {
    const out = await service.dedup([
      job({ id: 'ny', location: NEW_YORK }),
      job({ id: 'anywhere', site: Site.LINKEDIN }),
      job({ id: 'ldn', location: LONDON }),
    ]);
    // The location-less posting joins the first compatible group; London stays apart.
    expect(out.canonical).toHaveLength(2);
    expect(out.assignments[0]).toBe(out.assignments[1]);
    expect(out.assignments[2]).not.toBe(out.assignments[0]);
  });

  it('remote only merges with remote (or with no location)', async () => {
    const out = await service.dedup([
      job({ id: 'r1', isRemote: true, location: new LocationDto({ country: 'US' }) }),
      job({ id: 'r2', site: Site.LINKEDIN, location: new LocationDto({ city: 'Remote' }) }),
      job({ id: 'ny', site: Site.LEVER, location: NEW_YORK }),
    ]);
    expect(out.canonical).toHaveLength(2);
    expect(out.assignments[0]).toBe(out.assignments[1]);
    expect(out.assignments[2]).not.toBe(out.assignments[0]);
  });
});

describe('merge gate — employment-type rule (Spec 1724)', () => {
  let service: DedupHybridService;
  beforeEach(() => {
    service = new DedupHybridService();
  });

  it('does not hash-merge an internship with a full-time posting of the same title and city', async () => {
    const intern = job({ id: '1', location: NEW_YORK, employmentType: 'Summer Internship' });
    const fullTime = job({ id: '2', location: NEW_YORK, employmentType: 'Full-Time: New Grad' });
    expect(dedupKeyForJob(intern)).toBe(dedupKeyForJob(fullTime));

    const out = await service.dedup([intern, fullTime]);
    expect(out.canonical).toHaveLength(2);
    expect(new Set(out.canonical.map((c) => c.canonicalJobId)).size).toBe(2);
  });

  it('does not merge two different labels from the same source, even when both are full-time', async () => {
    const out = await service.dedup([
      job({ id: '1', location: NEW_YORK, employmentType: 'Full-Time: New Grad' }),
      job({ id: '2', location: NEW_YORK, employmentType: 'Full-Time: Experienced' }),
    ]);
    expect(out.canonical).toHaveLength(2);
  });

  it('merges across sources whose labels differ but whose classes agree', async () => {
    const out = await service.dedup([
      job({ id: 'gh', location: NEW_YORK, employmentType: 'Full-Time: Experienced' }),
      job({ id: 'li', site: Site.LINKEDIN, location: NEW_YORK, employmentType: 'Full-time', jobType: [JobType.FULL_TIME] }),
    ]);
    expect(out.canonical).toHaveLength(1);
  });

  it('merges when one side has no employment information', async () => {
    const out = await service.dedup([
      job({ id: 'gh', location: NEW_YORK, employmentType: 'Summer Internship' }),
      job({ id: 'li', site: Site.LINKEDIN, location: NEW_YORK }),
    ]);
    expect(out.canonical).toHaveLength(1);
  });

  it('reads jobType[] as well as the label', async () => {
    const out = await service.dedup([
      job({ id: 'a', site: Site.INDEED, location: NEW_YORK, jobType: [JobType.INTERNSHIP] }),
      job({ id: 'b', site: Site.LINKEDIN, location: NEW_YORK, jobType: [JobType.CONTRACT] }),
    ]);
    expect(out.canonical).toHaveLength(2);
  });
});

describe('merge gate — pure helpers (Spec 1724)', () => {
  it('sitesOf normalises cities, US states and countries', () => {
    expect(sitesOf(job({ location: new LocationDto({ city: 'New York', state: 'NY', country: 'US' }) }))).toEqual([
      { city: 'new york', state: 'new york', country: 'united states' },
    ]);
    expect(sitesOf(job({ location: null, isRemote: true }))).toEqual([{ remote: true }]);
    expect(sitesOf(job({ location: null }))).toEqual([]);
  });

  it('a site with fewer fields matches a fuller one; a disagreeing field never does', () => {
    const ny = sitesOf(job({ location: new LocationDto({ city: 'New York', state: 'NY' }) }));
    const nyFull = sitesOf(job({ location: NEW_YORK }));
    const sg = sitesOf(job({ location: new LocationDto({ country: 'Singapore' }) }));
    const hk = sitesOf(job({ location: HONG_KONG }));
    expect(siteSetsCompatible(ny, nyFull)).toBe(true);
    expect(siteSetsCompatible(hk, sg)).toBe(false);
    expect(siteSetsCompatible([], sg)).toBe(true);
  });

  it('employmentClassesOf maps labels and jobType to coarse classes', () => {
    expect(employmentClassesOf({ employmentType: 'Full-Time: New Grad' })).toEqual(['fulltime']);
    expect(employmentClassesOf({ employmentType: 'Summer Internship' })).toEqual(['internship']);
    expect(employmentClassesOf({ employmentType: 'Contract to hire', jobType: [JobType.FULL_TIME] })).toEqual([
      'contract',
      'fulltime',
    ]);
    expect(employmentClassesOf({ employmentType: 'Team B', jobType: [JobType.OTHER] })).toEqual([]);
  });

  it('profilesCompatible combines the rules', () => {
    const base = mergeProfileOf(job({ location: NEW_YORK, employmentType: 'Full-Time: Experienced' }));
    expect(profilesCompatible(base, mergeProfileOf(job({ location: NEW_YORK })))).toBe(true);
    expect(profilesCompatible(base, mergeProfileOf(job({ location: LONDON })))).toBe(false);
    expect(
      profilesCompatible(base, mergeProfileOf(job({ location: NEW_YORK, employmentType: 'Summer Internship' }))),
    ).toBe(false);
  });
});
