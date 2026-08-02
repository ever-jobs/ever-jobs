import 'reflect-metadata';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

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

import { IsolvedService } from '../src/isolved.service';

const BOARD_HTML = `
<html><head></head><body>
<script>
  window.bootstrapVue('#social-widget', {
    componentData: { organizationId: 9999, domainId: 8543, domainTitle: "Electra" }
  });
</script>
<job-listings></job-listings>
</body></html>
`;

function makeApiResponse(jobs: any[]) {
  return { success: true, data: { jobs, jobCount: jobs.length } };
}

function makeApiJob(overrides: Record<string, any> = {}) {
  return {
    id: 1734294,
    title: 'Aircraft Wiring Systems Lead',
    city: 'Manassas',
    abbreviation: 'VA',
    iso3: 'USA',
    classification: 'Engineering',
    orgTitle: 'Engineering',
    workplaceType: 'Onsite',
    employmentType: 'Full Time',
    minSalary: '130,000.00',
    maxSalary: '160,000.00',
    payType: 'Salary',
    payTypeFrame: 'per year',
    jobUrl: 'https://electra.isolvedhire.com/jobs/1734294',
    ...overrides,
  };
}

const DETAIL_HTML = `
<html><head>
<script type="application/ld+json">
{
  "@type": "JobPosting",
  "title": "Aircraft Wiring Systems Lead",
  "description": "<p>We are hiring a lead.</p>",
  "datePosted": "2026-03-24 00:00:00",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "name": "Electra" },
  "jobLocation": { "address": { "addressLocality": "Manassas", "addressRegion": "VA", "addressCountry": "US" } }
}
</script>
</head><body></body></html>
`;

function setupMockGet(responses: Record<string, any>) {
  // Match the most specific (longest) pattern first so a bare "/jobs/" board
  // key does not shadow "/core/jobs/{id}" or "/jobs/{id}.html".
  const entries = Object.entries(responses).sort((a, b) => b[0].length - a[0].length);
  mockGet.mockImplementation(async (url: string, opts?: any) => {
    for (const [pattern, data] of entries) {
      if (url.includes(pattern)) {
        return { data, status: 200 };
      }
    }
    throw Object.assign(new Error(`404 ${url}`), { response: { status: 404 } });
  });
}

describe('IsolvedService', () => {
  let service: IsolvedService;

  beforeEach(() => {
    service = new IsolvedService();
    mockGet.mockReset();
  });

  it('returns empty when no slug or url provided', async () => {
    const input = new ScraperInputDto({ siteType: [Site.ISOLVED] });
    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  it('returns empty for an unknown tenant (no domainId)', async () => {
    setupMockGet({ '/jobs/': '<html><body>no componentData</body></html>' });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: 'nonexistent-tenant',
    });
    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  it('extracts domainId and companyName from board HTML', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob()]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: 'electra',
      resultsWanted: 5,
      descriptionFormat: DescriptionFormat.PLAIN,
    });
    const result = await service.scrape(input);
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0].companyName).toBe('Electra');
  });

  it('maps all structured fields from the API', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob()]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companySlug: 'electra',
      resultsWanted: 10,
      descriptionFormat: DescriptionFormat.PLAIN,
    });
    const result = await service.scrape(input);
    const job = result.jobs[0];

    expect(job.title).toBe('Aircraft Wiring Systems Lead');
    expect(job.atsId).toBe('1734294');
    expect(job.site).toBe(Site.ISOLVED);
    expect(job.atsType).toBe('isolved');
    expect(job.department).toBe('Engineering');
    expect(job.employmentType).toBe('Full Time');
    expect(job.isRemote).toBe(false);
    expect(job.location).toEqual(expect.objectContaining({
      city: 'Manassas', state: 'VA', country: 'US',
    }));
    expect(job.jobUrl).toBe('https://electra.isolvedhire.com/jobs/1734294.html');
    expect(job.compensation).toBeDefined();
    expect(job.compensation!.minAmount).toBe(130000);
    expect(job.compensation!.maxAmount).toBe(160000);
    expect(job.compensation!.interval).toBe('yearly');
    expect(job.compensation!.currency).toBe('USD');
    expect(job.datePosted).toBe('2026-03-24');
    expect(job.description).toBeTruthy();
  });

  it('maps workplaceType "Remote" to isRemote=true', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ workplaceType: 'Remote' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('maps workplaceType "Work from home flexibility" to isRemote=true', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ workplaceType: 'Work from home flexibility' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('maps workplaceType "Onsite" to isRemote=false', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ workplaceType: 'Onsite' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].isRemote).toBe(false);
  });

  it('compensation is null when min/max salary are empty', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ minSalary: '', maxSalary: '', payTypeFrame: '' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].compensation).toBeNull();
  });

  it('respects resultsWanted limit', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeApiJob({ id: 1000 + i, title: `Job ${i}` }),
    );
    const responses: Record<string, any> = {
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse(jobs),
    };
    for (const j of jobs) {
      responses[`/jobs/${j.id}.html`] = DETAIL_HTML;
    }
    setupMockGet(responses);

    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 3,
    });
    const result = await service.scrape(input);
    expect(result.jobs.length).toBe(3);
  });

  it('resolves tenant from companyUrl', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob()]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED],
      companyUrl: 'https://electra.isolvedhire.com/jobs/',
      resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs.length).toBe(1);
  });

  it('department falls back to orgTitle when classification is absent', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ classification: null, orgTitle: 'Operations' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].department).toBe('Operations');
  });

  it('handles detail page with no JSON-LD gracefully', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob()]),
      '/jobs/1734294.html': '<html><body>No JSON-LD</body></html>',
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
      descriptionFormat: DescriptionFormat.PLAIN,
    });
    const result = await service.scrape(input);
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0].description).toBeNull();
    expect(result.jobs[0].datePosted).toBeNull();
    expect(result.jobs[0].department).toBe('Engineering');
    expect(result.jobs[0].compensation).toBeDefined();
  });

  it('returns empty when core-jobs API fails', async () => {
    setupMockGet({ '/jobs/': BOARD_HTML });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs).toEqual([]);
  });

  it('normalises iso3 country code to iso2', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ iso3: 'CAN', city: 'Toronto', abbreviation: 'ON' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].location?.country).toBe('CA');
  });

  it('parses hourly pay interval', async () => {
    setupMockGet({
      '/jobs/': BOARD_HTML,
      '/core/jobs/8543': makeApiResponse([makeApiJob({ minSalary: '25.00', maxSalary: '35.00', payTypeFrame: 'per hour' })]),
      '/jobs/1734294.html': DETAIL_HTML,
    });
    const input = new ScraperInputDto({
      siteType: [Site.ISOLVED], companySlug: 'electra', resultsWanted: 5,
    });
    const result = await service.scrape(input);
    expect(result.jobs[0].compensation?.interval).toBe('hourly');
    expect(result.jobs[0].compensation?.minAmount).toBe(25);
    expect(result.jobs[0].compensation?.maxAmount).toBe(35);
  });
});
