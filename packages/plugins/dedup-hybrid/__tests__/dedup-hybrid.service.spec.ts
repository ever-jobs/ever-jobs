import { CanonicalJobSchema, JobPostDto, LocationDto, OfficeDto, RawJobSchema, Site } from '@ever-jobs/models';
import { parseLocationList } from '@ever-jobs/common';
import { DedupHybridService } from '../src/dedup-hybrid.service';

/**
 * Budget for the COLD NFR-1 check below, and deliberately its own knob.
 *
 * This assertion times a single, unwarmed `dedup()` — the first in the worker
 * process — so it measures JIT compilation of the whole pipeline as much as it
 * measures throughput. Measured on the same CI runner: 1 251–1 451 ms cold here
 * versus 20–40 ms in `dedup-perf.spec.ts`, which builds its batch once and takes
 * the max over 5 warmed runs. A ~40x gap between the two is warm-up, not a
 * regression.
 *
 * It therefore must NOT share `DEDUP_PERF_NFR1_MS` with that suite: a ceiling
 * loose enough for a cold run (seconds) would render the warmed gate — the
 * authoritative NFR-1 check, at 250 ms — meaningless. Spec 1678 wired both to
 * one knob; this splits them again.
 */
const NFR1_COLD_BUDGET_MS = Number(process.env.DEDUP_COLD_NFR1_MS ?? 250);

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

  it(`meets NFR-1 cold — 1 000 mostly-unique jobs dedup in under ${NFR1_COLD_BUDGET_MS} ms`, async () => {
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
    expect(elapsed).toBeLessThan(NFR1_COLD_BUDGET_MS);
  });
});

describe('per-site locations[] and offices[] on CanonicalJob (Spec 5123)', () => {
  let service: DedupHybridService;

  beforeEach(() => {
    service = new DedupHybridService();
  });

  it('copies a singleton cluster\'s locations[]/offices[] unchanged', async () => {
    const locations = [
      new LocationDto({ city: 'Amsterdam', country: 'NL', text: 'Amsterdam' }),
      new LocationDto({ city: 'Remote - EMEA', text: 'Remote - EMEA' }),
    ];
    const offices = [
      new OfficeDto({ id: '42', name: 'US', city: 'Emeryville', state: 'CA', text: 'Emeryville, California, United States' }),
    ];
    const a = job({ id: '1', locations, offices });
    const out = await service.dedup([a]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].locations).toEqual(locations);
    expect(out.canonical[0].offices).toEqual(offices);
  });

  it('omits locations/offices when no observation carries them', async () => {
    const out = await service.dedup([job({ id: '1' })]);
    expect(out.canonical[0].locations).toBeUndefined();
    expect(out.canonical[0].offices).toBeUndefined();
  });

  it('unions offices[] across a hash-merged cluster, deduped on id', async () => {
    const shared = [new LocationDto({ city: 'Denver', state: 'CO', text: 'Denver, CO' })];
    const a = job({
      id: '1',
      locations: shared,
      offices: [
        new OfficeDto({ id: '1', name: 'Acme - Denver, CO (HQ)', city: 'Denver', state: 'CO' }),
        new OfficeDto({ id: '2', name: 'Acme - Oklahoma', state: 'OK' }),
      ],
    });
    const b = job({
      id: '2',
      site: Site.LINKEDIN,
      locations: shared.map((l) => new LocationDto({ ...l })),
      offices: [
        new OfficeDto({ id: '1', name: 'Acme - Denver, CO (HQ)', city: 'Denver', state: 'CO' }),
        new OfficeDto({ id: '3', name: 'Acme - Tulsa, OK', city: 'Tulsa', state: 'OK' }),
      ],
    });
    const out = await service.dedup([a, b]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].offices?.map((o) => o.id)).toEqual(['1', '2', '3']);
  });

  it('unions locations[] across a MinHash-welded cluster with differing site sets', async () => {
    const description =
      'We are hiring a senior engineer to own distributed systems design, ' +
      'mentor a team of eight, and drive quarterly reliability targets. ' +
      'Expect deep work in Go, Kubernetes, event sourcing, and large-scale data pipelines.';
    const a = job({
      id: '1',
      description,
      location: new LocationDto({ city: 'Amsterdam', country: 'NL' }),
      locations: [new LocationDto({ city: 'Amsterdam', country: 'NL', text: 'Amsterdam' })],
    });
    const b = job({
      id: '2',
      site: Site.LINKEDIN,
      description,
      location: new LocationDto({ city: 'Austin', state: 'TX' }),
      locations: [
        new LocationDto({ city: 'Amsterdam', country: 'NL', text: 'Amsterdam' }),
        new LocationDto({ city: 'Austin', state: 'TX', text: 'Austin, TX' }),
      ],
    });
    const out = await service.dedup([a, b]);

    expect(out.canonical).toHaveLength(1);
    const sites = out.canonical[0].locations?.map((l) => `${l.city}|${l.state ?? ''}`);
    expect(sites).toEqual(['Amsterdam|', 'Austin|TX']);
  });
});

describe('ATS posting countryCode on CanonicalJob (Spec 1689)', () => {
  let service: DedupHybridService;

  beforeEach(() => {
    service = new DedupHybridService();
  });

  it('carries a singleton observation\'s countryCode onto the canonical record', async () => {
    const out = await service.dedup([job({ id: '1', site: Site.LEVER, countryCode: 'NL' })]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].countryCode).toBe('NL');
    expect(out.canonical[0].fields['countryCode']).toMatchObject({
      value: 'NL',
      _source: Site.LEVER,
      _sourceId: '1',
    });
  });

  it('omits countryCode when no observation carries one', async () => {
    const out = await service.dedup([job({ id: '1' }), job({ id: '2', countryCode: '  ' })]);
    for (const record of out.canonical) {
      expect(record.countryCode).toBeUndefined();
      expect(record.fields['countryCode']).toBeUndefined();
    }
  });

  it('prefers the head observation\'s code', async () => {
    const a = job({ id: '1', site: Site.GREENHOUSE, countryCode: 'US' });
    const b = job({ id: '2', site: Site.LEVER, countryCode: 'CA' });
    const out = await service.dedup([a, b]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].countryCode).toBe('US');
  });

  it('falls back to a later observation when the head has none, with its provenance', async () => {
    const a = job({ id: '1', site: Site.LINKEDIN });
    const b = job({ id: '2', site: Site.WORKDAY, countryCode: 'DE' });
    const out = await service.dedup([a, b]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].countryCode).toBe('DE');
    expect(out.canonical[0].fields['countryCode']).toMatchObject({
      value: 'DE',
      _source: Site.WORKDAY,
      _sourceId: '2',
    });
  });

  it('does not change canonicalJobId (the key does not read countryCode)', async () => {
    const without = await service.dedup([job({ id: '1' })]);
    const withCode = await service.dedup([job({ id: '1', countryCode: 'NL' })]);
    expect(withCode.canonical[0].canonicalJobId).toBe(without.canonical[0].canonicalJobId);
  });

  it('round-trips through CanonicalJobSchema and RawJobSchema', async () => {
    const out = await service.dedup([job({ id: '1', site: Site.LEVER, countryCode: 'NL' })]);
    const parsed = CanonicalJobSchema.parse(out.canonical[0]);
    expect(parsed.countryCode).toBe('NL');

    const raw = RawJobSchema.parse({
      site: Site.LEVER,
      sourceJobId: 'lever-1',
      title: 'Operator',
      companyName: 'acme',
      jobUrl: 'https://jobs.lever.co/acme/1',
      countryCode: 'NL',
    });
    expect(raw.countryCode).toBe('NL');
    expect(
      RawJobSchema.parse({
        site: Site.LEVER,
        sourceJobId: 'lever-2',
        title: 'Operator',
        companyName: 'acme',
        jobUrl: 'https://jobs.lever.co/acme/2',
        countryCode: null,
      }).countryCode,
    ).toBeNull();
    expect(CanonicalJobSchema.safeParse({ ...parsed, countryCode: '' }).success).toBe(false);
  });
});

describe('remote postings hash-merge across sources (Spec 1689)', () => {
  let service: DedupHybridService;

  beforeEach(() => {
    service = new DedupHybridService();
  });

  // Distinct long descriptions keep MinHash (stage 2) out of it: a merge here
  // can only come from the stage-1 canonicalJobId hash.
  const DESCRIPTIONS = [
    'Build distributed ingestion pipelines in Rust, own on-call for the streaming tier, and mentor two junior engineers on observability.',
    'Design React component libraries, partner with product design on accessibility audits, and ship weekly experiments behind feature flags.',
    'Operate our Kubernetes fleet across three regions, automate Terraform drift detection, and lead the quarterly disaster-recovery game day.',
  ];

  /** A migrated plugin's row: the shared parser's output copied onto the DTO. */
  function parsedJob(id: string, label: string, emitRemoteCity: boolean, description: string): JobPostDto {
    const parsed = parseLocationList([label], { emitRemoteCity });
    return new JobPostDto({
      id,
      title: 'Staff Engineer',
      companyName: 'Acme',
      jobUrl: `https://jobs.example.com/${id}`,
      site: Site.LEVER,
      description,
      location: parsed.location ?? undefined,
      locations: parsed.locations,
      isRemote: parsed.remoteMentioned,
    });
  }

  /** An iCIMS-style row: a structured `{ city: 'Remote' }` and no parse. */
  function icimsRemote(description: string): JobPostDto {
    return new JobPostDto({
      id: 'icims-1',
      title: 'Staff Engineer',
      companyName: 'Acme',
      jobUrl: 'https://careers-acme.icims.com/jobs/1',
      site: Site.ICIMS,
      description,
      location: new LocationDto({ city: 'Remote' }),
      isRemote: true,
    });
  }

  it.each([false, true])(
    "merges a parsed 'Remote', a parsed 'Remote - US' and an iCIMS {city:'Remote'} into one record (emitRemoteCity=%s)",
    async (emitRemoteCity) => {
      const jobs = [
        parsedJob('lever-1', 'Remote', emitRemoteCity, DESCRIPTIONS[0]),
        parsedJob('lever-2', 'Remote - US', emitRemoteCity, DESCRIPTIONS[1]),
        icimsRemote(DESCRIPTIONS[2]),
      ];
      const out = await service.dedup(jobs);

      expect(out.canonical).toHaveLength(1);
      expect(out.canonical[0].sources).toHaveLength(3);
      expect(new Set(out.assignments).size).toBe(1);
    },
  );

  it('keys the parsed remote rows exactly as the iCIMS row (stage-1 hash, not MinHash)', async () => {
    const out = await service.dedup([
      parsedJob('lever-1', 'Remote', false, DESCRIPTIONS[0]),
      icimsRemote(DESCRIPTIONS[2]),
    ]);
    const icimsOnly = await service.dedup([icimsRemote(DESCRIPTIONS[2])]);

    expect(out.canonical).toHaveLength(1);
    expect(out.canonical[0].canonicalJobId).toBe(icimsOnly.canonical[0].canonicalJobId);
  });

  it('control: without the isRemote flag the parsed rows do NOT hash-merge', async () => {
    // Guards the wiring above: if dedup stopped passing `isRemote`, the
    // parsed 'Remote' / 'Remote - US' rows would key to '' / 'united states'.
    const strip = (j: JobPostDto): JobPostDto => new JobPostDto({ ...j, isRemote: undefined });
    const out = await service.dedup([
      strip(parsedJob('lever-1', 'Remote', false, DESCRIPTIONS[0])),
      strip(parsedJob('lever-2', 'Remote - US', false, DESCRIPTIONS[1])),
      icimsRemote(DESCRIPTIONS[2]),
    ]);
    expect(out.canonical).toHaveLength(3);
  });
});
