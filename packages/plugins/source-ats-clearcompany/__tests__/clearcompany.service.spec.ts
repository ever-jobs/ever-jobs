import * as fs from 'fs';
import * as path from 'path';
import { createHttpClient } from '@ever-jobs/common';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';
import { ClearCompanyService } from '../src/clearcompany.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

const SITE_ID = '00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5';

const siteFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'site-jobs.json'), 'utf8'),
);

const legacyFixture = [
  {
    Id: 'legacy-1',
    OrganizationName: 'Firefly Aerospace',
    PositionTitle: 'Legacy Feed Job',
    Description: 'from the API-ShortName feed',
    OpenDate: '2026-01-01T00:00:00Z',
    DepartmentName: 'Legacy Dept',
    OfficeName: 'Briggs TX Facility',
    ApplyUrl: 'https://firefly.clearcompany.com/careers/jobs/legacy-1/apply',
  },
];

describe('ClearCompanyService — per-site (widget) feed', () => {
  let service: ClearCompanyService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new ClearCompanyService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({
      get: getMock,
      setHeaders: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function mockSiteFeed(payload: unknown = siteFixture): void {
    getMock.mockImplementation((url: string) => {
      if (url.includes(`careers-api.clearcompany.com/v1/${SITE_ID}`)) {
        return Promise.resolve({ data: payload });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });
  }

  it('uses the careers-api site feed when companySlug is a GUID', async () => {
    mockSiteFeed();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: SITE_ID, resultsWanted: 50 }),
    );

    expect(getMock).toHaveBeenCalledWith(
      `https://careers-api.clearcompany.com/v1/${SITE_ID}`,
    );
    expect(res.jobs).toHaveLength(2);
  });

  it('uses the careers-api site feed when siteNumber carries the GUID', async () => {
    mockSiteFeed();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'firefly', siteNumber: SITE_ID }),
    );

    expect(res.jobs).toHaveLength(2);
    expect(res.jobs[0].companyName).toBe('Firefly Aerospace');
  });

  it('extracts siteId from a widget-embed companyUrl', async () => {
    mockSiteFeed();

    const res = await service.scrape(
      new ScraperInputDto({
        companyUrl: `https://careers-content.clearcompany.com/js/v1/career-site.js?siteId=${SITE_ID}`,
      }),
    );

    expect(res.jobs).toHaveLength(2);
  });

  it('maps widget-feed fields to JobPostDto', async () => {
    mockSiteFeed();

    const res = await service.scrape(
      new ScraperInputDto({
        companySlug: SITE_ID,
        descriptionFormat: DescriptionFormat.PLAIN,
      }),
    );

    const job = res.jobs[0];
    expect(job.site).toBe(Site.CLEARCOMPANY);
    expect(job.atsType).toBe('clearcompany');
    expect(job.atsId).toBe('f7d63d30-1fd7-5234-2323-5a996ff4ea3a');
    expect(job.id).toBe('clearcompany-f7d63d30-1fd7-5234-2323-5a996ff4ea3a');
    expect(job.title).toBe('GNC Engineer II (Hypersonics)');
    expect(job.companyName).toBe('Firefly Aerospace');
    expect(job.applyUrl).toBe(
      'https://firefly.clearcompany.com/careers/jobs/f7d63d30-1fd7-5234-2323-5a996ff4ea3a/apply',
    );
    expect(job.jobUrl).toBe(
      'https://firefly.clearcompany.com/careers/jobs/f7d63d30-1fd7-5234-2323-5a996ff4ea3a',
    );
    expect(job.department).toBe('Aerospace Software Engineering');
    expect(job.datePosted).toBe('2026-09-12');
    expect(job.isRemote).toBe(true);
    expect(job.locations).toHaveLength(2);
    expect(job.locations?.[0].city).toBe('Cedar Park');
    expect(job.locations?.[0].state).toBe('Texas');
    expect(job.locations?.[0].country).toBe('US');
    expect(job.description).toContain('Guidance');
    expect(job.emails).toContain('jobs@firefly.example');
  });

  it('falls back to officeName when locations[] is empty', async () => {
    mockSiteFeed();

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: SITE_ID }),
    );

    const tech = res.jobs[1];
    expect(tech.department).toBe('Launch Operations'); // jobFunctionName fallback
    expect(tech.datePosted).toBe('2026-08-01'); // openDate when postedDate null
    expect(tech.location).toBeTruthy();
  });

  it('falls back to the slug feed when the site feed is empty', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes(`careers-api.clearcompany.com/v1/${SITE_ID}`)) {
        return Promise.resolve({ data: { results: [], totalCount: 0 } });
      }
      if (url.includes('careers-page.clearcompany.com/api/v1/careers/jobs')) {
        return Promise.resolve({ data: legacyFixture });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'firefly', siteNumber: SITE_ID }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Legacy Feed Job');
    expect(res.jobs[0].atsId).toBe('legacy-1');
  });

  it('keeps the legacy slug path when no GUID is supplied', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('careers-page.clearcompany.com/api/v1/careers/jobs')) {
        return Promise.resolve({ data: legacyFixture });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(new ScraperInputDto({ companySlug: 'firefly' }));

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(res.jobs[0].jobUrl).toBe(
      'https://careers-page.clearcompany.com/jobs/firefly/legacy-1',
    );
  });

  it('treats an unknown site id as empty, not an error', async () => {
    // siteId feed 404s; the fallback slug feed 400s on the same GUID-shaped
    // "slug" — both are known-tenant-miss statuses and degrade to empty.
    getMock.mockImplementation((url: string) => {
      const err: any = new Error('Not Found');
      err.response = { status: url.includes('careers-api.') ? 404 : 400 };
      return Promise.reject(err);
    });

    const res = await service.scrape(new ScraperInputDto({ companySlug: SITE_ID }));

    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeUndefined();
  });
});
