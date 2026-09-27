/**
 * Unit tests for `scripts/probe-ats-delegate-company-source.ts` (Spec 1735).
 *
 * The network layer is replaced by an injected transport and pacer, so these
 * tests pin the politeness contract (serial, paced, at most three requests per
 * company, stop at the first verified board, honest UA) and the pure decision
 * surface (request building, gating, listing extraction per backend) without
 * touching a live host.
 */
import {
  buildProbeRequest,
  countJobs,
  extractListings,
  gateVariant,
  MAX_VARIANTS_PER_COMPANY,
  MIN_INTERVAL_MS,
  parseWorkdaySlug,
  plannedVariants,
  probeCandidates,
  PROBE_USER_AGENT,
  ProbeRequest,
  SerialPacer,
  workdayRequisitionId,
} from '../probe-ats-delegate-company-source';

const WORKDAY_PAGE = {
  total: 1529,
  jobPostings: [
    {
      title: ' Software Engineer Intern ',
      externalPath: '/job/California---San-Francisco/Software-Engineer-Intern_JR1-1',
      locationsText: 'California - San Francisco',
      postedOn: 'Posted Today',
      bulletFields: ['JR1'],
    },
    { title: '', externalPath: '/job/x/Blank_JR2' },
    {
      title: 'New Grad Engineer',
      externalPath: '/job/Remote/New-Grad-Engineer_JR3',
      locationsText: '2 Locations',
      postedOn: 'Posted 3 Days Ago',
      bulletFields: ['JR3'],
    },
  ],
};

describe('parseWorkdaySlug / buildProbeRequest', () => {
  it('parses the compound slug with the adapter defaults', () => {
    expect(parseWorkdaySlug('salesforce:12:External_Career_Site')).toEqual({
      tenant: 'salesforce',
      wdNumber: '12',
      site: 'External_Career_Site',
    });
    expect(parseWorkdaySlug('acme')).toEqual({ tenant: 'acme', wdNumber: '5', site: 'External' });
  });

  it('builds the single Workday search POST the adapter would send (page 1 only)', () => {
    const req = buildProbeRequest({ backend: 'workday', slug: 'walmart:504:WalmartExternal' });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://walmart.wd504.myworkdayjobs.com/wday/cxs/walmart/WalmartExternal/jobs');
    expect(JSON.parse(req.body!)).toEqual({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
  });

  it('builds listing-only GETs for every other backend', () => {
    expect(buildProbeRequest({ backend: 'greenhouse', slug: 'janestreet' })).toEqual({
      method: 'GET',
      url: 'https://api.greenhouse.io/v1/boards/janestreet/jobs',
    });
    expect(buildProbeRequest({ backend: 'lever', slug: 'belvederetrading' }).url).toBe(
      'https://api.lever.co/v0/postings/belvederetrading?mode=json',
    );
    expect(buildProbeRequest({ backend: 'ashby', slug: 'voleon' }).url).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/voleon',
    );
    expect(buildProbeRequest({ backend: 'smartrecruiters', slug: 'Visa' }).url).toBe(
      'https://api.smartrecruiters.com/v1/companies/Visa/postings?limit=100',
    );
    expect(buildProbeRequest({ backend: 'icims', slug: 'careers-sig' }).url).toBe(
      'https://careers-sig.icims.com/jobs/search?ss=1&in_iframe=1',
    );
    expect(buildProbeRequest({ backend: 'avature', slug: 'https://careers.example.com/' }).url).toBe(
      'https://careers.example.com/careers/SearchJobs/?jobOffset=0&jobRecordsPerPage=12',
    );
  });

  it('never asks Greenhouse for full descriptions', () => {
    expect(buildProbeRequest({ backend: 'greenhouse', slug: 'x' }).url).not.toContain('content=true');
  });
});

describe('workdayRequisitionId', () => {
  it('skips badges, locations, labels and dates that share bulletFields with the id', () => {
    // Shapes recorded live on 2026-09-24 (Intel, Motorola Solutions, GM, Wells Fargo, Moderna, Morgan Stanley).
    expect(workdayRequisitionId(['Spotlight Job', 'JR0287131'], '/job/x/Role_JR0287131')).toBe('JR0287131');
    expect(workdayRequisitionId(['Greater Chicago Area', 'R68894'], null)).toBe('R68894');
    expect(workdayRequisitionId(['JR-202620783', 'Exempt'], null)).toBe('JR-202620783');
    expect(workdayRequisitionId(['R-577758', 'Posting End Date: 09/30/2026'], null)).toBe('R-577758');
    expect(workdayRequisitionId(['Norwood, Massachusetts', 'Technical Development', 'R19218'], null)).toBe('R19218');
    expect(workdayRequisitionId(['PT-JR043680'], null)).toBe('PT-JR043680');
  });

  it('falls back to the detail path tail, else null', () => {
    expect(workdayRequisitionId(['Spotlight Job'], '/job/Austin-TX/Engineer_R-101')).toBe('R-101');
    expect(workdayRequisitionId(null, '/job/no-underscore')).toBeNull();
    expect(workdayRequisitionId([], null)).toBeNull();
  });
});

describe('extractListings / countJobs / gateVariant', () => {
  it('records Workday listings with the fields the fixture needs, skipping untitled rows', () => {
    const out = extractListings('workday', WORKDAY_PAGE);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'JR1',
      title: 'Software Engineer Intern',
      location: 'California - San Francisco',
      department: null,
      updatedAt: null,
      externalPath: '/job/California---San-Francisco/Software-Engineer-Intern_JR1-1',
      postedOn: 'Posted Today',
      bulletFields: ['JR1'],
    });
  });

  it('prefers the backend total over the page length', () => {
    expect(countJobs('workday', WORKDAY_PAGE)).toBe(1529);
    expect(countJobs('greenhouse', { jobs: [{ title: 'a' }, { title: 'b' }], meta: { total: 2 } })).toBe(2);
    expect(countJobs('smartrecruiters', { content: [{ name: 'a' }], totalFound: 40 })).toBe(40);
    expect(countJobs('lever', [{ text: 'a' }, { text: 'b' }, { text: 'c' }])).toBe(3);
  });

  it('normalises Greenhouse, Lever, Ashby and SmartRecruiters postings', () => {
    expect(
      extractListings('greenhouse', {
        jobs: [{ id: 42, title: 'Quant Trader Intern', location: { name: 'New York' }, updated_at: '2026-09-21T11:16:43-04:00' }],
      })[0],
    ).toEqual({
      id: '42',
      title: 'Quant Trader Intern',
      location: 'New York',
      department: null,
      updatedAt: '2026-09-21T15:16:43.000Z',
    });
    expect(
      extractListings('lever', [
        { id: 'l1', text: 'Trader', categories: { location: 'Chicago', team: 'Trading' }, createdAt: 1790000000000 },
      ])[0],
    ).toMatchObject({ id: 'l1', title: 'Trader', location: 'Chicago', department: 'Trading' });
    expect(
      extractListings('ashby', { jobs: [{ id: 'a1', title: 'Researcher', location: 'Berkeley, CA', department: 'Research' }] })[0],
    ).toMatchObject({ id: 'a1', title: 'Researcher', location: 'Berkeley, CA', department: 'Research' });
    expect(
      extractListings('smartrecruiters', {
        content: [{ id: 's1', name: 'Analyst', location: { fullLocation: 'Austin, TX' }, department: { label: 'Ops' } }],
      })[0],
    ).toMatchObject({ id: 's1', title: 'Analyst', location: 'Austin, TX', department: 'Ops' });
  });

  it('extracts distinct job links from iCIMS and Avature HTML, skipping apply decoys', () => {
    const icims =
      '<div class="iCIMS_JobCardItem"><a class="iCIMS_Anchor" href="https://careers-x.icims.com/jobs/101/intern/job?in_iframe=1">' +
      '<span class="field-label">Title</span><h3>Intern &amp; Co-op</h3></a></div>' +
      '<a href="https://careers-x.icims.com/jobs/101/intern/job">Apply</a>' +
      '<a href="https://careers-x.icims.com/jobs/102/grad/job"><h3>New Grad</h3></a>';
    const ids = extractListings('icims', icims).map((l) => l.id);
    expect(ids).toEqual(['101', '102']);
    const avature =
      '<a href="/careers/JobDetail/Engineer/123">Engineer</a><a href="/careers/JobDetail/Engineer/123">Apply now</a>';
    expect(extractListings('avature', avature)).toHaveLength(1);
  });

  it('gates on at least one title-bearing posting and caps the recorded listings at 3', () => {
    const many = { jobs: Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Role ${i}` })) };
    const gate = gateVariant('greenhouse', many);
    expect(gate.ok).toBe(true);
    expect(gate.jobCount).toBe(10);
    expect(gate.listings).toHaveLength(3);
    expect(gateVariant('greenhouse', { jobs: [] }).ok).toBe(false);
    expect(gateVariant('workday', { total: 0, jobPostings: [{ title: '' }] }).ok).toBe(false);
    expect(gateVariant('lever', { not: 'an array' }).ok).toBe(false);
  });
});

describe('plannedVariants', () => {
  it('dedupes, drops unknown backends and blank slugs, and caps at three', () => {
    const planned = plannedVariants({
      key: 'x',
      displayName: 'X',
      variants: [
        { backend: 'greenhouse', slug: 'a' },
        { backend: 'greenhouse', slug: ' a ' },
        { backend: 'nope' as any, slug: 'b' },
        { backend: 'lever', slug: '  ' },
        { backend: 'lever', slug: 'c' },
        { backend: 'ashby', slug: 'd' },
        { backend: 'workday', slug: 'e:1:F' },
      ],
    });
    expect(planned).toEqual([
      { backend: 'greenhouse', slug: 'a' },
      { backend: 'lever', slug: 'c' },
      { backend: 'ashby', slug: 'd' },
    ]);
    expect(MAX_VARIANTS_PER_COMPANY).toBe(3);
  });
});

describe('SerialPacer', () => {
  it('spaces request starts by at least the minimum interval', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const pacer = new SerialPacer(MIN_INTERVAL_MS, () => now, async (ms) => {
      sleeps.push(ms);
      now += ms;
    });
    await pacer.wait(); // first request: no wait
    now += 200;
    await pacer.wait(); // 200 ms later: waits the remaining 900
    now += 5_000;
    await pacer.wait(); // long after: no wait
    expect(sleeps).toEqual([MIN_INTERVAL_MS - 200]);
    expect(MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('probeCandidates', () => {
  function transportFrom(answers: Record<string, { status: number | null; json: unknown }>) {
    const calls: ProbeRequest[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = async (req: ProbeRequest) => {
      calls.push(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return answers[req.url] ?? { status: 404, json: null };
    };
    return { calls, transport, maxInFlight: () => maxInFlight };
  }
  const noWaitPacer = () => new SerialPacer(0, () => 0, async () => undefined);

  it('stops at the first verified variant and records every attempt', async () => {
    const t = transportFrom({
      'https://api.greenhouse.io/v1/boards/good/jobs': { status: 200, json: { jobs: [{ id: 1, title: 'Intern' }] } },
    });
    const report = await probeCandidates(
      [
        {
          key: 'acme',
          displayName: 'Acme',
          variants: [
            { backend: 'greenhouse', slug: 'wrong' },
            { backend: 'greenhouse', slug: 'good' },
            { backend: 'lever', slug: 'never-tried' },
          ],
        },
      ],
      { transport: t.transport, pacer: noWaitPacer(), today: '2026-09-24' },
    );
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://api.greenhouse.io/v1/boards/wrong/jobs',
      'https://api.greenhouse.io/v1/boards/good/jobs',
    ]);
    expect(report.requests).toBe(2);
    expect(report.verified).toHaveLength(1);
    expect(report.verified[0]).toMatchObject({
      key: 'acme',
      backend: 'greenhouse',
      companySlug: 'good',
      jobCount: 1,
      verifiedAt: '2026-09-24',
    });
    expect(report.verified[0].attempts.map((a) => a.outcome)).toEqual(['http_error', 'verified']);
    expect(report.userAgent).toBe(PROBE_USER_AGENT);
  });

  it('never spends more than three requests on a company, and never runs two at once', async () => {
    const t = transportFrom({});
    const report = await probeCandidates(
      [
        {
          key: 'ghost',
          displayName: 'Ghost',
          variants: ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ backend: 'greenhouse' as const, slug })),
        },
        { key: 'ghost2', displayName: 'Ghost 2', variants: [{ backend: 'ashby', slug: 'z' }] },
      ],
      { transport: t.transport, pacer: noWaitPacer() },
    );
    expect(t.calls).toHaveLength(4);
    expect(t.maxInFlight()).toBe(1);
    expect(report.verified).toEqual([]);
    expect(report.rejected.map((r) => [r.key, r.attempts.length])).toEqual([
      ['ghost', 3],
      ['ghost2', 1],
    ]);
  });

  it('classifies empty boards, bad payloads and network errors distinctly', async () => {
    const t = transportFrom({
      'https://api.greenhouse.io/v1/boards/empty/jobs': { status: 200, json: { jobs: [] } },
      'https://api.greenhouse.io/v1/boards/garbled/jobs': { status: 200, json: null },
      'https://api.greenhouse.io/v1/boards/down/jobs': { status: null, json: null },
    });
    const report = await probeCandidates(
      [
        {
          key: 'x',
          displayName: 'X',
          variants: ['empty', 'garbled', 'down'].map((slug) => ({ backend: 'greenhouse' as const, slug })),
        },
      ],
      { transport: t.transport, pacer: noWaitPacer() },
    );
    expect(report.rejected[0].attempts.map((a) => a.outcome)).toEqual(['empty', 'bad_payload', 'network_error']);
  });

  it('identifies itself honestly', () => {
    expect(PROBE_USER_AGENT).toMatch(/^EverJobs-SourceVerifier\//);
    expect(PROBE_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });
});
