import 'reflect-metadata';
import {
  CompensationInterval,
  DescriptionFormat,
  JobType,
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

import { BreezyHRService } from '../src/breezyhr.service';
import { BreezyJob } from '../src/breezyhr.types';

function listing(overrides: Partial<BreezyJob> = {}): BreezyJob {
  return {
    id: 'job-1',
    friendly_id: 'friendly-1',
    name: 'Senior Engineer',
    type: { id: 'fullTime', name: 'Full-Time' },
    location: {
      city: 'Austin',
      state: { id: 'TX', name: 'Texas' },
      country: { id: 'US', name: 'United States' },
      name: 'Austin, TX',
      is_remote: false,
    },
    published_date: '2026-06-01',
    salary: '$105k - $125k',
    ...overrides,
  };
}

function detailPage(description: string, baseSalary?: unknown): string {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Senior Engineer',
    description,
    jobLocationType: null,
    employmentType: 'FULL_TIME',
  };
  if (baseSalary !== undefined) ld.baseSalary = baseSalary;
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'WebSite' })}</script>
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    </head><body>page</body></html>`;
}

/** Route the mocked GET by URL: list endpoint vs per-job detail page. */
function mockBoard(jobs: BreezyJob[], detailHtmlById: Record<string, string>) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/json')) return Promise.resolve({ data: jobs });
    const match = url.match(/\/p\/([^/]+)$/);
    if (match) {
      const html = detailHtmlById[match[1]];
      return html != null
        ? Promise.resolve({ data: html })
        : Promise.reject(new Error('404'));
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: 'acme',
    siteType: [Site.BREEZYHR],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('BreezyHRService', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('parses structured location instead of stringifying state/country objects', async () => {
    mockBoard([listing()], { 'friendly-1': detailPage('<p>Body</p>') });

    const result = await new BreezyHRService().scrape(input());

    expect(result.jobs).toHaveLength(1);
    const loc = result.jobs[0].location;
    expect(loc?.city).toBe('Austin');
    expect(loc?.state).toBe('TX');
    expect(loc?.country).toBe('United States');
    expect(JSON.stringify(loc)).not.toContain('[object Object]');
  });

  it('fetches the detail page and extracts description from the JobPosting ld+json (markdown default)', async () => {
    mockBoard([listing()], {
      'friendly-1': detailPage('<h2>About</h2><p>Build things.</p>'),
    });

    const result = await new BreezyHRService().scrape(input());

    expect(result.jobs[0].description).toContain('About');
    expect(result.jobs[0].description).toContain('Build things.');
    // markdown rendering, not raw HTML tags
    expect(result.jobs[0].description).not.toContain('<h2>');
  });

  it('honors descriptionFormat=html and =plain', async () => {
    mockBoard([listing()], {
      'friendly-1': detailPage('<p>Hello <b>world</b></p>'),
    });

    const htmlRes = await new BreezyHRService().scrape(
      input({ descriptionFormat: DescriptionFormat.HTML }),
    );
    expect(htmlRes.jobs[0].description).toBe('<p>Hello <b>world</b></p>');

    mockBoard([listing()], {
      'friendly-1': detailPage('<p>Hello <b>world</b></p>'),
    });
    const plainRes = await new BreezyHRService().scrape(
      input({ descriptionFormat: DescriptionFormat.PLAIN }),
    );
    expect(plainRes.jobs[0].description).toContain('Hello world');
    expect(plainRes.jobs[0].description).not.toContain('<b>');
  });

  it('extracts yearly compensation from the salary free text', async () => {
    mockBoard([listing({ salary: '$105k - $125k' })], {
      'friendly-1': detailPage('<p>x</p>'),
    });

    const comp = (await new BreezyHRService().scrape(input())).jobs[0]
      .compensation;
    expect(comp?.minAmount).toBe(105000);
    expect(comp?.maxAmount).toBe(125000);
    expect(comp?.currency).toBe('USD');
    expect(comp?.interval).toBe(CompensationInterval.YEARLY);
  });

  it('extracts hourly compensation from the salary free text', async () => {
    mockBoard([listing({ salary: '$19.00 - $27.00 / hr' })], {
      'friendly-1': detailPage('<p>x</p>'),
    });

    const comp = (await new BreezyHRService().scrape(input())).jobs[0]
      .compensation;
    expect(comp?.minAmount).toBe(19);
    expect(comp?.maxAmount).toBe(27);
    expect(comp?.interval).toBe(CompensationInterval.HOURLY);
  });

  it('uses the company display name (company.name) over the slug', async () => {
    mockBoard([listing({ company: { name: 'Acme Inc.' } })], {
      'friendly-1': detailPage('<p>x</p>'),
    });

    const result = await new BreezyHRService().scrape(input());
    expect(result.jobs[0].companyName).toBe('Acme Inc.');
  });

  it('falls back to the slug when company.name is absent', async () => {
    mockBoard([listing()], { 'friendly-1': detailPage('<p>x</p>') });

    const result = await new BreezyHRService().scrape(input());
    expect(result.jobs[0].companyName).toBe('acme');
  });

  it('prefers structured baseSalary over the free-text salary heuristic', async () => {
    // Free text "$30 - $45" parses as hourly, but the detail ld+json baseSalary
    // declares YEAR — the structured source is authoritative.
    mockBoard([listing({ salary: '$30 - $45' })], {
      'friendly-1': detailPage('<p>x</p>', {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: 30,
          maxValue: 45,
          unitText: 'YEAR',
        },
      }),
    });

    const job = (await new BreezyHRService().scrape(input())).jobs[0];
    expect(job.compensation?.minAmount).toBe(30);
    expect(job.compensation?.maxAmount).toBe(45);
    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(job.salarySource).toBe('structured');
  });

  it('sets salarySource=description when only the free-text salary is present', async () => {
    mockBoard([listing({ salary: '$105k - $125k' })], {
      'friendly-1': detailPage('<p>x</p>'),
    });

    const job = (await new BreezyHRService().scrape(input())).jobs[0];
    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(job.salarySource).toBe('description');
  });

  it('maps jobType and employmentType from the type node', async () => {
    mockBoard(
      [
        listing({ id: 'a', friendly_id: 'fa', type: { id: 'fullTime', name: 'Full-Time' } }),
        listing({ id: 'b', friendly_id: 'fb', type: { id: 'contract', name: 'Contract' } }),
      ],
      { fa: detailPage('<p>a</p>'), fb: detailPage('<p>b</p>') },
    );

    const jobs = (await new BreezyHRService().scrape(input())).jobs;
    expect(jobs[0].jobType).toEqual([JobType.FULL_TIME]);
    expect(jobs[0].employmentType).toBe('Full-Time');
    expect(jobs[1].jobType).toEqual([JobType.CONTRACT]);
    expect(jobs[1].employmentType).toBe('Contract');
  });

  it('is fail-safe: a failed detail fetch leaves description null but still maps the job', async () => {
    mockBoard([listing()], {}); // no detail HTML => detail GET rejects

    const result = await new BreezyHRService().scrape(input());
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].description).toBeNull();
    // structured list fields are still mapped
    expect(result.jobs[0].location?.city).toBe('Austin');
    expect(result.jobs[0].compensation?.minAmount).toBe(105000);
  });

  it('sets isRemote from location.is_remote', async () => {
    mockBoard(
      [
        listing({
          id: 'r',
          friendly_id: 'fr',
          location: { city: 'Anywhere', is_remote: true },
        }),
      ],
      { fr: detailPage('<p>x</p>') },
    );

    const result = await new BreezyHRService().scrape(input());
    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('omits compensation when no salary text is present', async () => {
    mockBoard([listing({ salary: null })], {
      'friendly-1': detailPage('<p>x</p>'),
    });

    const result = await new BreezyHRService().scrape(input());
    expect(result.jobs[0].compensation ?? null).toBeNull();
  });
});
