/**
 * Vanity-slug tenant resolution for `source-ats-eddy` (Spec 5146).
 *
 * Eddy careers URLs commonly carry the tenant's vanity short name rather than the
 * organization UUID (`app.eddy.com/careers/{slug}[...]`). The adapter resolves the slug
 * through the same public lookup the careers SPA issues —
 * `GET /api/ds/organization/{slug}/id` → `{organizationUuid}` — before calling the
 * UUID-keyed jobs endpoints. These tests mock the HTTP layer and assert the
 * resolution order: UUID inputs never trigger the lookup; slug inputs issue exactly
 * one; failures degrade to empty.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import { EddyModule, EddyService } from '../src';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});

const ORG_UUID = 'd7e3b662-b7f9-458c-8a91-34374094c69f';
const JOB_UUID = 'ce246f3d-f062-4520-b738-5e97c60b9e50';

const LIST_ITEM = {
  jobOpeningUuid: JOB_UUID,
  title: 'Senior Platform Software Engineer',
  departmentId: 3512,
  locationId: 14113,
  postedDate: '2026-09-01T10:00:00Z',
};

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.EDDY],
    resultsWanted: 10,
    descriptionFormat: DescriptionFormat.MARKDOWN,
    ...overrides,
  });
}

describe('EddyService — vanity-slug resolution', () => {
  let service: EddyService;
  let getMock: jest.Mock;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [EddyModule],
    }).compile();
    service = module.get<EddyService>(EddyService);
  });

  beforeEach(() => {
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({
      get: getMock,
      setHeaders: jest.fn(),
    });
  });

  it('resolves a bare vanity companySlug via the slug-lookup endpoint', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes(`/api/ds/organization/hypercraftusa/id`)) {
        return Promise.resolve({
          data: { currentShortName: 'hypercraftusa', organizationUuid: ORG_UUID },
        });
      }
      if (url.includes(`/api/ats/public/job-opening/organization/${ORG_UUID}`)) {
        return Promise.resolve({ data: [LIST_ITEM] });
      }
      if (url.includes(`/api/ats/public/job-opening/${JOB_UUID}/organization/${ORG_UUID}`)) {
        return Promise.resolve({ data: { title: LIST_ITEM.title } });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input({ companySlug: 'hypercraftusa' }));

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe(JOB_UUID);
    expect(res.jobs[0].jobUrl).toContain(`/careers/${ORG_UUID}/${JOB_UUID}`);
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(getMock.mock.calls[0][0]).toContain('/api/ds/organization/hypercraftusa/id');
    expect(getMock.mock.calls[1][0]).toContain(`/job-opening/organization/${ORG_UUID}`);
  });

  it('resolves the slug from a /careers/{slug}/preview/embed companyUrl', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/api/ds/organization/')) {
        return Promise.resolve({
          data: { currentShortName: 'hypercraftusa', organizationUuid: ORG_UUID },
        });
      }
      if (url.includes('/api/ats/public/job-opening/organization/')) {
        return Promise.resolve({ data: [LIST_ITEM] });
      }
      if (url.includes('/api/ats/public/job-opening/')) {
        return Promise.resolve({ data: null });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(
      input({ companyUrl: 'https://app.eddy.com/careers/hypercraftusa/preview/embed' }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(getMock.mock.calls[0][0]).toContain('/api/ds/organization/hypercraftusa/id');
    // "preview"/"embed" must never be treated as the slug.
    expect(getMock.mock.calls[0][0]).not.toContain('/preview/');
    expect(getMock.mock.calls[0][0]).not.toContain('/embed/');
  });

  it('issues no slug lookup when companySlug is already a UUID', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes(`/job-opening/organization/${ORG_UUID}`)) {
        return Promise.resolve({ data: [LIST_ITEM] });
      }
      if (url.includes('/api/ats/public/job-opening/')) {
        return Promise.resolve({ data: null });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input({ companySlug: ORG_UUID }));

    expect(res.jobs).toHaveLength(1);
    expect(getMock.mock.calls.every(([u]) => !u.includes('/api/ds/organization/'))).toBe(
      true,
    );
  });

  it('resolves the slug from a UUID-less companyUrl on the careers host', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/api/ds/organization/')) {
        return Promise.resolve({
          data: { currentShortName: 'hypercraftusa', organizationUuid: ORG_UUID },
        });
      }
      if (url.includes('/api/ats/public/job-opening/organization/')) {
        return Promise.resolve({ data: [LIST_ITEM] });
      }
      return Promise.resolve({ data: null });
    });

    const res = await service.scrape(
      input({ companyUrl: 'https://app.eddy.com/careers/hypercraftusa' }),
    );

    expect(res.jobs).toHaveLength(1);
    expect(getMock.mock.calls[0][0]).toContain('/api/ds/organization/hypercraftusa/id');
  });

  it('returns empty when the slug lookup 404s', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/api/ds/organization/')) {
        const err: any = new Error('Request failed with status code 404');
        err.response = { status: 404 };
        return Promise.reject(err);
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input({ companySlug: 'no-such-org-xyz' }));

    expect(res.jobs).toHaveLength(0);
    // Never reaches the jobs endpoints.
    expect(
      getMock.mock.calls.every(([u]) => u.includes('/api/ds/organization/')),
    ).toBe(true);
  });

  it('returns empty when the lookup body carries no UUID', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/api/ds/organization/')) {
        return Promise.resolve({ data: { currentShortName: 'weird' } });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input({ companySlug: 'weird' }));

    expect(res.jobs).toHaveLength(0);
  });

  it('still returns empty for a non-Eddy companyUrl', async () => {
    const res = await service.scrape(
      input({ companyUrl: 'https://careers.example.com/jobs' }),
    );

    expect(res.jobs).toHaveLength(0);
    expect(getMock).not.toHaveBeenCalled();
  });
});
