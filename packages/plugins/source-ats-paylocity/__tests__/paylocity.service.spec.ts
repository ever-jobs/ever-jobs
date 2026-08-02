import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { PaylocityService } from '../src/paylocity.service';

const FIX = join(__dirname, 'fixtures');
const fixture = (name: string): string =>
  readFileSync(join(FIX, name), 'utf-8');

const SCS_GUID = '3ecffcba-6b5a-4a7e-b71b-bbb54a4527ab';
const FERMI_GUID = 'add565e9-4cee-4334-8182-9de221ffb9e4';

/** Route the mocked GET to the right board/detail fixture by URL. */
function mockBoard(
  boardFixture: string,
  detailByJobId: Record<string, string | Error>,
) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/jobs/All/')) {
      return Promise.resolve({ data: fixture(boardFixture) });
    }
    const m = url.match(/\/jobs\/Details\/([^/]+)\//);
    if (m) {
      const entry = detailByJobId[m[1]];
      if (entry == null) return Promise.resolve({ data: '<html></html>' });
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve({ data: fixture(entry) });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: FERMI_GUID,
    siteType: [Site.PAYLOCITY],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('PaylocityService', () => {
  let service: PaylocityService;

  beforeEach(() => {
    mockGet.mockReset();
    service = new PaylocityService();
  });

  it('maps every board job with company name and stable ids', async () => {
    mockBoard('board-fermi.html', {});
    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(18);
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.PAYLOCITY);
      expect(job.atsType).toBe('paylocity');
      expect(job.companyName).toBe('Fermi LLC');
      expect(job.id).toMatch(/^paylocity-/);
      expect(job.jobUrl).toContain('/recruiting/jobs/Details/');
      expect(job.title).toBeTruthy();
    }
  });

  it('overlays detail page for description, jobType, and structured fields', async () => {
    mockBoard('board-fermi.html', {
      '4248451': 'detail-fermi-4248451.html',
    });
    const res = await service.scrape(
      input({ descriptionFormat: DescriptionFormat.PLAIN }),
    );

    const tax = res.jobs.find((j) => j.atsId === '4248451');
    expect(tax).toBeDefined();
    expect(tax!.title).toBe('Corporate Tax Director');
    expect(tax!.location?.city).toBe('Dallas');
    expect(tax!.location?.state).toBe('TX');
    expect(tax!.location?.country).toBe('USA');
    expect(tax!.department).toBe('Finance');
    expect(tax!.employmentType).toBe('Full-time');
    expect(tax!.jobType).toEqual([JobType.FULL_TIME]);
    expect(tax!.isRemote).toBe(false);
    expect(tax!.datePosted).toBe('2026-06-11');
    expect(tax!.description).toBeTruthy();
    expect(tax!.description!.length).toBeGreaterThan(200);
    // No salary range in the description → null compensation.
    expect(tax!.compensation == null).toBe(true);
  });

  it('detects remote jobs and sets workFromHomeType', async () => {
    mockBoard('board-fermi.html', {});
    const res = await service.scrape(input());

    const remote = res.jobs.find((j) => j.atsId === '4140027');
    expect(remote).toBeDefined();
    expect(remote!.isRemote).toBe(true);
    expect(remote!.workFromHomeType).toBe('Remote');
  });

  it('prefers structured ld+json baseSalary over description text, and strips the module id from companyName', async () => {
    mockBoard('board-sendcutsend.html', {
      '4272751': 'detail-sendcutsend-4272751.html',
    });
    const res = await service.scrape(
      input({
        companySlug: SCS_GUID,
        descriptionFormat: DescriptionFormat.PLAIN,
      }),
    );

    expect(res.jobs).toHaveLength(7);
    // ModuleTitle is "SendCutSend Inc [175255]" — the bracketed module id is
    // not part of the company name.
    expect(res.jobs[0].companyName).toBe('SendCutSend Inc');
    expect(res.jobs[0].companyName).not.toContain('[');

    const tech = res.jobs.find((j) => j.atsId === '4272751');
    expect(tech).toBeDefined();
    expect(tech!.description).toBeTruthy();
    expect(tech!.compensation).toBeDefined();
    expect(tech!.compensation!.minAmount).toBe(22);
    expect(tech!.compensation!.maxAmount).toBe(40);
    expect(tech!.compensation!.interval).toBe(CompensationInterval.HOURLY);
    // Pay is taken from the structured baseSalary, not text-parsed.
    expect(tech!.salarySource).toBe('structured');
  });

  it('still maps a job when its detail fetch fails (fail-safe)', async () => {
    mockBoard('board-fermi.html', {
      '4248451': new Error('500'),
    });
    const res = await service.scrape(input());

    const tax = res.jobs.find((j) => j.atsId === '4248451');
    expect(tax).toBeDefined();
    expect(tax!.title).toBe('Corporate Tax Director');
    expect(tax!.location?.city).toBe('Dallas');
    expect(tax!.description == null).toBe(true);
    expect(tax!.employmentType == null).toBe(true);
  });

  it('respects resultsWanted for both jobs and detail fetches', async () => {
    mockBoard('board-fermi.html', {});
    const res = await service.scrape(input({ resultsWanted: 3 }));

    expect(res.jobs).toHaveLength(3);
    const detailCalls = mockGet.mock.calls.filter((c: [string]) =>
      c[0].includes('/jobs/Details/'),
    );
    expect(detailCalls).toHaveLength(3);
  });

  it('returns empty for a missing companySlug', async () => {
    const res = await service.scrape(input({ companySlug: undefined }));
    expect(res.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns empty when the board has no pageData', async () => {
    mockGet.mockResolvedValue({ data: '<html><body>no data</body></html>' });
    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(0);
  });

  it('returns empty when the board fetch throws', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(0);
  });

  /** Build a board page with one job for a synthetic detail page. */
  function synthBoard(moduleTitle: string): string {
    const pageData = {
      ModuleTitle: moduleTitle,
      Jobs: [
        {
          JobId: 1,
          JobTitle: 'Engineer',
          JobLocation: { City: 'Reno', State: 'NV', Country: 'USA' },
          PublishedDate: '2026-06-11T10:00:00-05:00',
        },
      ],
    };
    return `<html><body><script>window.pageData = ${JSON.stringify(
      pageData,
    )};</script></body></html>`;
  }

  function mockSynth(boardHtml: string, detailHtml: string) {
    mockGet.mockImplementation((url: string) =>
      url.includes('/jobs/All/')
        ? Promise.resolve({ data: boardHtml })
        : Promise.resolve({ data: detailHtml }),
    );
  }

  it('builds description from all visible sections, not just the ld+json Description', async () => {
    // ld+json description carries only the "Description" section; the
    // "Salary Description" section is visible on the page but absent from it.
    const detail = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Engineer',
        description: '<p>Build things.</p>',
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'USD',
          value: {
            '@type': 'QuantitativeValue',
            minValue: 100000,
            maxValue: 130000,
            unitText: 'YEAR',
          },
        },
      })}</script></head><body>
      <div class="job-listing-header">Job Type</div><div>Full-time</div>
      <div class="job-listing-header">Description</div><div><p>Build things.</p></div>
      <div class="job-listing-header">Salary Description</div><div><p>$100,000 - $130,000 per year plus generous equity.</p></div>
      </body></html>`;
    mockSynth(synthBoard('Acme Inc [99]'), detail);

    const res = await service.scrape(
      input({ companySlug: SCS_GUID, descriptionFormat: DescriptionFormat.PLAIN }),
    );

    const job = res.jobs[0];
    expect(job.companyName).toBe('Acme Inc');
    // The "Salary Description" section (absent from ld+json) is in the body.
    expect(job.description).toContain('Build things.');
    expect(job.description).toContain('equity');
    // Pay comes from the structured baseSalary, not text.
    expect(job.compensation!.minAmount).toBe(100000);
    expect(job.compensation!.maxAmount).toBe(130000);
    expect(job.compensation!.interval).toBe(CompensationInterval.YEARLY);
    expect(job.salarySource).toBe('structured');
  });

  it('falls back to description text for pay when ld+json has no baseSalary', async () => {
    const detail = `<html><body>
      <div class="job-listing-header">Description</div><div><p>Operate the laser. Compensation: $30.00 - $45.00/hour.</p></div>
      </body></html>`;
    mockSynth(synthBoard('Acme Inc'), detail);

    const res = await service.scrape(
      input({ companySlug: SCS_GUID, descriptionFormat: DescriptionFormat.PLAIN }),
    );

    const job = res.jobs[0];
    expect(job.compensation!.minAmount).toBe(30);
    expect(job.compensation!.maxAmount).toBe(45);
    expect(job.compensation!.interval).toBe(CompensationInterval.HOURLY);
    expect(job.salarySource).toBe('description');
  });
});
