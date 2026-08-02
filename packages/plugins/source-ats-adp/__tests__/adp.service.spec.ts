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

import { AdpService } from '../src/adp.service';
import { AdpJob } from '../src/adp.types';

const LIST_RE = /\/job-requisitions\?cid=([^&]+)$/;
const DETAIL_RE = /\/job-requisitions\/([^/?]+)\?cid=/;

function listing(overrides: Partial<AdpJob> = {}): AdpJob {
  return {
    itemID: '9201050875412_1',
    requisitionTitle: 'VP, Government Affairs',
    postDate: '2026-06-29T16:54:00.000-04:00',
    workLevelCode: { shortName: 'Full Time' },
    payGradeRange: {
      minimumRate: { amountValue: 225000, currencyCode: 'USD' },
      maximumRate: { amountValue: 275000, currencyCode: 'USD' },
    },
    customFieldGroup: {
      stringFields: [
        {
          nameCode: { codeValue: 'SalaryRange' },
          stringValue: '225000.00 To 275000.00 (USD) Annually',
        },
      ],
    },
    requisitionLocations: [
      {
        nameCode: { shortName: 'Washington, DC, US' },
        address: {
          cityName: 'Washington',
          countrySubdivisionLevel1: { codeValue: 'DC' },
        },
      },
    ],
    ...overrides,
  };
}

/**
 * Route the mocked GET: 404 (reject) any host that is not `onHost`, so the
 * service's host fallback is exercised. The matching host serves the list and,
 * for each itemID present in `detailById`, the per-requisition detail.
 */
function mockApi(
  jobs: AdpJob[],
  detailById: Record<string, AdpJob | Error> = {},
  onHost = 'workforcenow.adp.com',
) {
  mockGet.mockImplementation((url: string) => {
    if (!url.includes(onHost)) {
      return Promise.reject(new Error(`GET ${url} failed: 404`));
    }
    const detailMatch = url.match(DETAIL_RE);
    if (detailMatch) {
      const entry = detailById[decodeURIComponent(detailMatch[1])];
      if (entry == null) return Promise.reject(new Error('404'));
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve({ data: entry });
    }
    if (LIST_RE.test(url)) {
      return Promise.resolve({ data: { jobRequisitions: jobs } });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: 'cid-1',
    siteType: [Site.ADP],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('AdpService', () => {
  let service: AdpService;

  beforeEach(() => {
    mockGet.mockReset();
    service = new AdpService();
  });

  it('maps the real API shape and overlays the detail-only description', async () => {
    mockApi([listing()], {
      '9201050875412_1': listing({
        requisitionDescription: '<div><p>Lead policy work.</p></div>',
      }),
    });

    const res = await service.scrape(
      input({ descriptionFormat: DescriptionFormat.PLAIN }),
    );

    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.title).toBe('VP, Government Affairs');
    expect(job.description).toBe('Lead policy work.');
    expect(job.location?.city).toBe('Washington');
    expect(job.location?.state).toBe('DC');
    expect(job.employmentType).toBe('Full Time');
    expect(job.isRemote).toBe(false);
    expect(job.compensation?.minAmount).toBe(225000);
    expect(job.compensation?.maxAmount).toBe(275000);
    expect(job.compensation?.currency).toBe('USD');
    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(job.site).toBe(Site.ADP);
    expect(job.atsType).toBe('adp');
    expect(job.atsId).toBe('9201050875412_1');
    expect(job.id).toBe('adp-9201050875412_1');
    expect(job.jobUrl).toContain('jobId=9201050875412_1');
  });

  it('falls back to the cloud host when the primary host 404s', async () => {
    mockApi(
      [listing({ requisitionLocations: [{ nameCode: { shortName: 'Remote, US' } }] })],
      {
        '9201050875412_1': listing({
          requisitionDescription: '<p>Body</p>',
          requisitionLocations: [{ nameCode: { shortName: 'Remote, US' } }],
        }),
      },
      'workforcenow.cloud.adp.com',
    );

    const res = await service.scrape(input({ companySlug: 'cid-2' }));

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('workforcenow.cloud.adp.com'),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('VP, Government Affairs');
    expect(res.jobs[0].isRemote).toBe(true);
    expect(res.jobs[0].workFromHomeType).toBe('Remote');
  });

  it('returns an empty result for a company with no open requisitions', async () => {
    mockApi([]);

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
  });

  it('still maps a job when its detail fetch fails (list-only fallback)', async () => {
    mockApi([listing()], { '9201050875412_1': new Error('boom') });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('VP, Government Affairs');
    expect(res.jobs[0].description).toBeNull();
  });

  it('returns empty when no host resolves the company', async () => {
    mockGet.mockRejectedValue(new Error('404'));

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
  });
});
