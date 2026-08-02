import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, setHeaders: mockSetHeaders })),
  };
});

import { NiceboardService } from '../src/niceboard.service';

/** One page of the Niceboard `/api/jobs` search feed. */
function respondWith(jobs: unknown[]) {
  mockGet.mockResolvedValue({ data: { jobs, count: jobs.length } });
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.NICEBOARD],
    companySlug: 'acme',
    resultsWanted: 10,
    ...overrides,
  });
}

describe('NiceboardService — apply email vs URL (mailto is not an applyUrl)', () => {
  let service: NiceboardService;

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    service = new NiceboardService();
  });

  it('carries apply_email in emails and leaves applyUrl as the on-board job page (no mailto)', async () => {
    respondWith([
      {
        id: 101,
        title: 'Welder',
        slug: 'welder',
        company_slug: 'acme',
        apply_email: 'jobs@acme.example',
        description_html: '<p>Weld things.</p>',
      },
    ]);

    const { jobs } = await service.scrape(inputFrom());
    const job = jobs.find((j) => j.atsId === '101')!;

    expect(job.emails).toEqual(['jobs@acme.example']);
    expect(job.applyUrl).toBe(job.jobUrl);
    expect(job.applyUrl?.startsWith('mailto:')).toBe(false);
  });

  it('unions apply_email with addresses found in the description (de-duped, apply_email first)', async () => {
    respondWith([
      {
        id: 102,
        title: 'Fitter',
        slug: 'fitter',
        company_slug: 'acme',
        apply_email: 'hiring@acme.example',
        description_html: '<p>Email hiring@acme.example or team@acme.example.</p>',
      },
    ]);

    const { jobs } = await service.scrape(inputFrom());
    const job = jobs.find((j) => j.atsId === '102')!;

    expect(job.emails).toEqual(['hiring@acme.example', 'team@acme.example']);
  });

  it('keeps a real off-board apply_url as applyUrl', async () => {
    respondWith([
      {
        id: 103,
        title: 'Machinist',
        slug: 'machinist',
        company_slug: 'acme',
        apply_url: 'https://careers.acme.example/apply/machinist',
        apply_email: 'jobs@acme.example',
        description_html: '<p>Machine parts.</p>',
      },
    ]);

    const { jobs } = await service.scrape(inputFrom());
    const job = jobs.find((j) => j.atsId === '103')!;

    expect(job.applyUrl).toBe('https://careers.acme.example/apply/machinist');
    // apply_email is still surfaced on emails
    expect(job.emails).toEqual(['jobs@acme.example']);
  });
});
