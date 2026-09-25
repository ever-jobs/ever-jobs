import * as fs from 'fs';
import * as path from 'path';
import { createHttpClient } from '@ever-jobs/common';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { NodiGlobalService } from '../src/nodi_global.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

const offersFixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'job-offers.json'),
    'utf8',
  ),
);
const companyFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'company.json'), 'utf8'),
);

describe('NodiGlobalService', () => {
  let service: NodiGlobalService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new NodiGlobalService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function mockApi(offers: unknown = offersFixture): void {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/job-offers/active/company/')) {
        return Promise.resolve({ data: offers });
      }
      if (url.includes('/companies/by-name')) {
        return Promise.resolve({ data: companyFixture });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });
  }

  it('maps the API shape to JobPostDto', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai', resultsWanted: 999 }),
    );

    expect(res.jobs).toHaveLength(2);
    const job = res.jobs[0];
    expect(job.site).toBe(Site.NODI_GLOBAL);
    expect(job.title).toBe('Full Stack Engineer');
    expect(job.id).toBe(
      'nodi_global-radical ai-1de1fd23-e074-4d59-9078-9b5801c8acae',
    );
    expect(job.atsId).toBe('1de1fd23-e074-4d59-9078-9b5801c8acae');
    expect(job.jobUrl).toBe(
      'https://app.nodi.global/jobs/public/1de1fd23-e074-4d59-9078-9b5801c8acae',
    );
    expect(job.applyUrl).toBe(job.jobUrl);
  });

  it('resolves company name/website via the by-name endpoint', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai' }),
    );

    const job = res.jobs[0];
    expect(job.companyName).toBe('Radical AI');
    expect(job.companyUrl).toBe('https://radical-ai.com');
  });

  it('maps location, type, modality, seniority-adjacent fields', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai' }),
    );

    const job = res.jobs[0];
    expect(job.location?.city).toBe('Brooklyn Navy Yard');
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.employmentType).toBe('Full-time');
    expect(job.isRemote).toBe(false);
    expect(job.workFromHomeType).toBe('On Site');
    expect(job.department).toBe('Engineering');
    expect(job.datePosted).toBe('2026-09-18');
  });

  it('maps salary range to compensation', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai' }),
    );

    const comp = res.jobs[0].compensation;
    expect(comp?.minAmount).toBe(175000);
    expect(comp?.maxAmount).toBe(225000);
    expect(comp?.currency).toBe('USD');
    expect(comp?.interval).toBe('yearly');
  });

  it('strips HTML from description', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai' }),
    );

    const desc = res.jobs[0].description ?? '';
    expect(desc).not.toContain('<h2>');
    expect(desc).toContain('Full Stack Engineer');
  });

  it('honours resultsWanted', async () => {
    mockApi();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai', resultsWanted: 1 }),
    );

    expect(res.jobs).toHaveLength(1);
  });

  it('honours offset (plugins own it; the core does not apply it)', async () => {
    mockApi();
    const first = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai', resultsWanted: 2 }),
    );
    mockApi();
    const second = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai', resultsWanted: 1, offset: 1 }),
    );

    expect(first.jobs.length).toBe(2);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0].id).toBe(first.jobs[1].id);
  });

  it('returns empty when the company endpoint 404s', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/job-offers/')) {
        return Promise.reject(new Error('404'));
      }
      return Promise.resolve({ data: companyFixture });
    });

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'no-such-co' }),
    );

    expect(res.jobs).toHaveLength(0);
  });

  it('still maps jobs when the by-name lookup fails', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/job-offers/')) {
        return Promise.resolve({ data: offersFixture });
      }
      return Promise.reject(new Error('boom'));
    });

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'radical ai' }),
    );

    expect(res.jobs).toHaveLength(2);
    expect(res.jobs[0].companyName).toBe('radical ai');
  });

  it('returns empty when companySlug is missing', async () => {
    const res = await service.scrape(new ScraperInputDto());
    expect(res.jobs).toHaveLength(0);
  });
});
