import 'reflect-metadata';
import {
  CompensationInterval,
  DescriptionFormat,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { DoverService } from '../src/dover.service';
import {
  DoverJobDetail,
  DoverJobsResponse,
  DoverListJob,
} from '../src/dover.types';

const CLIENT_ID = '08fa6161-f59a-43eb-8035-0b8acebac5af';

const SLUG_RE = /\/api\/v1\/careers-page-slug\/([^/?]+)$/;
const PAGE_RE = /\/api\/v1\/careers-page\/([^/?]+)$/;
const JOBS_RE = /\/api\/v1\/careers-page\/[^/?]+\/jobs/;
const DETAIL_RE = /\/api\/v1\/inbound\/application-portal-job\/([^/?]+)$/;

function listJob(over: Partial<DoverListJob> = {}): DoverListJob {
  return {
    id: 'job-1',
    title: 'Senior Robotics Engineer',
    workplace_type: 'ONSITE',
    locations: [
      { location_type: 'IN_OFFICE', location_option: { city: 'San Francisco', state: 'CA', country: 'United States' } },
    ],
    is_published: true,
    is_sample: false,
    ...over,
  };
}

function detail(over: Partial<DoverJobDetail> = {}): DoverJobDetail {
  return {
    id: 'job-1',
    client_name: 'Gradient Robotics',
    title: 'Senior Robotics Engineer',
    user_provided_description: '<p>Build robots.</p>',
    workplace_type: 'ONSITE',
    created: '2026-06-20T12:00:00Z',
    locations: [
      { location_type: 'IN_OFFICE', location_option: { city: 'San Francisco', state: 'CA', country: 'United States' } },
    ],
    compensation: {
      lower_bound: 150000,
      upper_bound: 200000,
      currency_code: 'USD',
      salary_range_type: 'YEARLY',
      employment_type: 'FULL_TIME',
    },
    ...over,
  };
}

/**
 * Route a mocked GET by URL. `pages` keys a slug/uuid → resolution payload (or
 * null to 404); `jobs` is the list response; `details` maps jobId → detail.
 */
function routeGet(opts: {
  pages?: Record<string, { id?: string; name?: string; slug?: string } | null>;
  jobs?: DoverJobsResponse | Record<string, DoverJobsResponse>;
  details?: Record<string, DoverJobDetail | null>;
}): void {
  mockGet.mockImplementation(async (url: string) => {
    const notFound = () => {
      const err: any = new Error('Not Found');
      err.response = { status: 404 };
      throw err;
    };

    const slugMatch = SLUG_RE.exec(url);
    if (slugMatch) {
      const key = decodeURIComponent(slugMatch[1]);
      const page = opts.pages?.[key];
      if (!page) return notFound();
      return { data: page };
    }

    if (JOBS_RE.test(url)) {
      const jobs = opts.jobs ?? { results: [] };
      const data = 'results' in jobs ? jobs : (jobs as Record<string, DoverJobsResponse>)[url] ?? { results: [] };
      return { data };
    }

    const pageMatch = PAGE_RE.exec(url);
    if (pageMatch) {
      const key = decodeURIComponent(pageMatch[1]);
      const page = opts.pages?.[key];
      if (!page) return notFound();
      return { data: page };
    }

    const detailMatch = DETAIL_RE.exec(url);
    if (detailMatch) {
      const key = decodeURIComponent(detailMatch[1]);
      const d = opts.details?.[key];
      if (d === undefined || d === null) return notFound();
      return { data: d };
    }

    return notFound();
  });
}

describe('DoverService (unit)', () => {
  let service: DoverService;

  beforeEach(() => {
    mockGet.mockReset();
    service = new DoverService();
  });

  it('resolves a slug, lists jobs, and overlays detail into a JobPostDto', async () => {
    routeGet({
      pages: { gradientrobotics: { id: CLIENT_ID, name: 'Gradient Robotics', slug: 'gradientrobotics' } },
      jobs: { results: [listJob()], next: null },
      details: { 'job-1': detail() },
    });

    const res = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.DOVER],
        companySlug: 'gradientrobotics',
        descriptionFormat: DescriptionFormat.PLAIN,
      }),
    );

    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.title).toBe('Senior Robotics Engineer');
    // Company name comes from client_name — never the slug.
    expect(job.companyName).toBe('Gradient Robotics');
    expect(job.site).toBe(Site.DOVER);
    expect(job.atsType).toBe('dover');
    expect(job.atsId).toBe('job-1');
    expect(job.id).toBe('dover-job-1');
    expect(job.jobUrl).toBe('https://app.dover.com/jobs/gradientrobotics');
    expect(job.description).toBe('Build robots.');
    expect(job.datePosted).toBe('2026-06-20');
    expect(job.isRemote).toBe(false);
    expect(job.employmentType).toBe('Full Time');
    expect(job.location?.city).toBe('San Francisco');
    expect(job.location?.state).toBe('CA');
    // Structured compensation wins over any free-text parse.
    expect(job.compensation?.minAmount).toBe(150000);
    expect(job.compensation?.maxAmount).toBe(200000);
    expect(job.compensation?.currency).toBe('USD');
    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(job.salarySource).toBe('structured');
  });

  it('resolves a careers-page UUID directly without a slug lookup', async () => {
    routeGet({
      pages: { [CLIENT_ID]: { id: CLIENT_ID, name: 'Create Me', slug: 'createme' } },
      jobs: { results: [listJob({ id: 'j9', title: 'Designer' })], next: null },
      details: { j9: detail({ id: 'j9', title: 'Designer', client_name: 'Create Me' }) },
    });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: CLIENT_ID }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].companyName).toBe('Create Me');
    // The slug-resolution endpoint must never be hit for a UUID identifier.
    const slugCalls = mockGet.mock.calls.filter(([u]) => SLUG_RE.test(u as string));
    expect(slugCalls).toHaveLength(0);
  });

  it('falls back to a hyphenated slug variant for a multi-word company name', async () => {
    routeGet({
      pages: { 'somewear-labs': { id: CLIENT_ID, name: 'Somewear Labs', slug: 'somewear-labs' } },
      jobs: { results: [listJob({ id: 'sw1', title: 'Firmware Engineer' })], next: null },
      details: { sw1: detail({ id: 'sw1', title: 'Firmware Engineer', client_name: 'Somewear Labs' }) },
    });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: 'Somewear Labs' }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].companyName).toBe('Somewear Labs');
  });

  it('marks REMOTE workplace roles as remote', async () => {
    routeGet({
      pages: { acme: { id: CLIENT_ID, name: 'Acme', slug: 'acme' } },
      jobs: { results: [listJob({ id: 'r1', workplace_type: 'REMOTE', locations: [] })], next: null },
      details: { r1: detail({ id: 'r1', workplace_type: 'REMOTE', locations: [], client_name: 'Acme' }) },
    });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: 'acme' }),
    );

    expect(res.jobs[0].isRemote).toBe(true);
    expect(res.jobs[0].location?.city).toBe('Remote');
  });

  it('excludes Dover sample/demo roles', async () => {
    routeGet({
      pages: { acme: { id: CLIENT_ID, name: 'Acme', slug: 'acme' } },
      jobs: {
        results: [listJob({ id: 'real', title: 'Real Role' }), listJob({ id: 'demo', is_sample: true })],
        next: null,
      },
      details: { real: detail({ id: 'real', title: 'Real Role', client_name: 'Acme' }) },
    });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: 'acme' }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('real');
  });

  it('still emits a role from the listing when its detail 404s', async () => {
    routeGet({
      pages: { acme: { id: CLIENT_ID, name: 'Acme', slug: 'acme' } },
      jobs: { results: [listJob({ id: 'orphan', title: 'Orphan Role' })], next: null },
      details: {},
    });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: 'acme' }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Orphan Role');
    // The listing carries no company name; only the careers-page name is known.
    expect(res.jobs[0].companyName).toBe('Acme');
  });

  it('returns empty for an unresolvable tenant', async () => {
    routeGet({ pages: {}, jobs: { results: [] }, details: {} });

    const res = await service.scrape(
      new ScraperInputDto({ siteType: [Site.DOVER], companySlug: 'does-not-exist-xyz' }),
    );

    expect(res.jobs).toHaveLength(0);
  });

  it('returns empty when no companySlug or companyUrl is given', async () => {
    const res = await service.scrape(new ScraperInputDto({ siteType: [Site.DOVER] }));
    expect(res.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('parses the board slug out of a /jobs/{slug} companyUrl', async () => {
    routeGet({
      pages: { gradientrobotics: { id: CLIENT_ID, name: 'Gradient Robotics', slug: 'gradientrobotics' } },
      jobs: { results: [listJob()], next: null },
      details: { 'job-1': detail() },
    });

    const res = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.DOVER],
        companyUrl: 'https://app.dover.com/jobs/gradientrobotics',
      }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].companyName).toBe('Gradient Robotics');
  });
});
