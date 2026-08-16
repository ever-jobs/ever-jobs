import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import { DedupHybridService } from '../src/dedup-hybrid.service';

/**
 * Same budget knob `dedup-perf.spec.ts` uses, and the one CI already sets
 * (`DEDUP_PERF_NFR1_MS`, see the `Run feature plugin tests` step). This
 * assertion was hardcoded to the local default, so the documented CI ceiling
 * never reached it and a contended shared runner failed the job on wall-clock
 * alone rather than on a real regression.
 */
const NFR1_BUDGET_MS = Number(process.env.DEDUP_PERF_NFR1_MS ?? 250);

function job(partial: Partial<JobPostDto>): JobPostDto {
  return new JobPostDto({
    title: 'Senior Software Engineer',
    companyName: 'Acme, Inc.',
    jobUrl: 'https://acme.example.com/jobs/1',
    site: Site.GREENHOUSE,
    location: new LocationDto({ city: 'San Francisco', state: 'CA', country: 'USA' }),
    ...partial,
  });
}

describe('DedupHybridService', () => {
  let service: DedupHybridService;

  beforeEach(() => {
    service = new DedupHybridService();
  });

  it('returns one canonical record for identical inputs', async () => {
    const a = job({ id: '1', site: Site.GREENHOUSE });
    const b = job({ id: '2', site: Site.LINKEDIN });
    const out = await service.dedup([a, b]);

    expect(out.canonical).toHaveLength(1);
    expect(out.metrics.inputCount).toBe(2);
    expect(out.metrics.outputCount).toBe(1);
    expect(out.metrics.mergedPairs).toBe(1);
    expect(out.errors).toHaveLength(0);
    expect(out.assignments).toHaveLength(2);
    expect(out.assignments[0]).toEqual(out.assignments[1]);
    expect(out.canonical[0].sources).toHaveLength(2);
  });

  it('collapses cosmetic-only company differences into one record', async () => {
    const a = job({ id: '1', companyName: 'Acme, Inc.', site: Site.GREENHOUSE });
    const b = job({ id: '2', companyName: 'ACME Inc', site: Site.LINKEDIN });
    const c = job({ id: '3', companyName: 'Acme', site: Site.LEVER });
    const out = await service.dedup([a, b, c]);
    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].sources).toHaveLength(3);
    expect(out.canonical[0].company).toBe('acme');
  });

  it('keeps different titles separate', async () => {
    const a = job({ id: '1', title: 'Senior Software Engineer', site: Site.GREENHOUSE });
    const b = job({ id: '2', title: 'Product Manager', site: Site.LINKEDIN });
    const out = await service.dedup([a, b]);
    expect(out.canonical).toHaveLength(2);
    expect(out.metrics.mergedPairs).toBe(0);
    expect(out.assignments[0]).not.toEqual(out.assignments[1]);
  });

  it('rejects entries missing required identity fields', async () => {
    const good = job({ id: '1' });
    const badNoTitle = new JobPostDto({
      title: '',
      companyName: 'Acme',
      jobUrl: 'https://x.test',
      site: Site.LEVER,
    });
    const out = await service.dedup([good, badNoTitle]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].inputIndex).toBe(1);
    expect(out.errors[0].code).toBe('ERR_DEDUP_INVALID_INPUT');
    expect(out.assignments[1]).toBeNull();
    expect(out.canonical).toHaveLength(1);
  });

  it('emits a sha-256 hex canonicalJobId of the right shape', async () => {
    const a = job({ id: '1' });
    const out = await service.dedup([a]);
    expect(out.canonical[0].canonicalJobId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces deterministic output for the same input', async () => {
    const inputs = [
      job({ id: '1', site: Site.GREENHOUSE }),
      job({ id: '2', site: Site.LINKEDIN }),
      job({ id: '3', title: 'Designer', site: Site.LEVER }),
    ];
    const a = await service.dedup(inputs);
    const b = await service.dedup(inputs);

    expect(a.canonical.map((j) => j.canonicalJobId).sort()).toEqual(
      b.canonical.map((j) => j.canonicalJobId).sort(),
    );
    expect(a.assignments).toEqual(b.assignments);
  });

  it('returns an empty result for empty input', async () => {
    const out = await service.dedup([]);
    expect(out.canonical).toHaveLength(0);
    expect(out.assignments).toHaveLength(0);
    expect(out.metrics.inputCount).toBe(0);
    expect(out.metrics.outputCount).toBe(0);
    expect(out.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('attaches provenance to every materialised field', async () => {
    const a = job({ id: '1', site: Site.GREENHOUSE });
    const out = await service.dedup([a]);
    const fields = out.canonical[0].fields;
    for (const fieldName of ['title', 'company', 'location', 'url']) {
      expect(fields[fieldName]).toBeDefined();
      expect(fields[fieldName]._source).toBe(Site.GREENHOUSE);
      expect(typeof fields[fieldName]._observedAt).toBe('string');
    }
  });

  it('merges near-duplicate descriptions across sources via MinHash', async () => {
    const desc =
      'We are hiring a Staff Backend Engineer to lead our distributed-systems team. ' +
      'You will design and operate Kubernetes-based platforms in production. ' +
      'Strong TypeScript / Go experience required, plus 7+ years of work on high-scale ' +
      'distributed services. We offer equity, a remote-friendly culture, and an ' +
      'engineering team that values mentorship and craft.';
    const tweaked = desc + ' Visa sponsorship available. Generous PTO.';

    // Different titles → Stage 1 (hash) cannot merge; Stage 2 (MinHash) must.
    const a = job({
      id: '1',
      title: 'Staff Backend Engineer',
      description: desc,
      site: Site.GREENHOUSE,
    });
    const b = job({
      id: '2',
      title: 'Senior Backend Engineer',
      description: tweaked,
      site: Site.LINKEDIN,
    });

    const out = await service.dedup([a, b]);
    expect(out.canonical).toHaveLength(1);
    expect(out.metrics.mergedPairs).toBe(1);
    expect(out.assignments[0]).toEqual(out.assignments[1]);
  });

  it('keeps unrelated long descriptions separate', async () => {
    const a = job({
      id: '1',
      title: 'Staff Backend Engineer',
      description:
        'Hiring a backend engineer experienced with distributed databases, ' +
        'event sourcing, and large-scale data pipelines.',
      site: Site.GREENHOUSE,
    });
    const b = job({
      id: '2',
      title: 'Lead UX Designer',
      description:
        'Hiring a UX lead to drive end-to-end design of mobile and web products. ' +
        'Strong Figma fluency, design-system stewardship, and user research required.',
      site: Site.LINKEDIN,
    });
    const out = await service.dedup([a, b]);
    expect(out.canonical).toHaveLength(2);
    expect(out.metrics.mergedPairs).toBe(0);
  });

  it(`meets NFR-1 — 1 000 mostly-unique jobs dedup in under ${NFR1_BUDGET_MS} ms`, async () => {
    const inputs: JobPostDto[] = [];
    for (let i = 0; i < 1000; i++) {
      // Force a 5x duplication factor — 200 distinct logical jobs.
      const k = i % 200;
      inputs.push(
        job({
          id: String(i),
          title: `Engineer ${k}`,
          companyName: `Company ${k}`,
          jobUrl: `https://e.test/${i}`,
          site: i % 2 === 0 ? Site.GREENHOUSE : Site.LINKEDIN,
        }),
      );
    }
    const start = Date.now();
    const out = await service.dedup(inputs);
    const elapsed = Date.now() - start;

    expect(out.metrics.outputCount).toBe(200);
    expect(out.metrics.mergedPairs).toBe(800);
    expect(elapsed).toBeLessThan(NFR1_BUDGET_MS);
  });
});
