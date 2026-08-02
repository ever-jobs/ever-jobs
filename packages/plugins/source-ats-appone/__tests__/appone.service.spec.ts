import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, JobType, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture pipeline
// instead of jobs.appone.com / apply.appone.com.
const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { ApponeModule, ApponeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const LIST_RESPONSE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'appone-list-response.json'), 'utf8'),
) as Record<string, unknown>;

/**
 * Spec 5036 — `ApponeService` unit tests (mocked HTTP).
 *
 * The list fixture carries 3 postings (ONSITE / REMOTE / HYBRID). Detail
 * fetches are routed by URL: a `/jobposting/{id}` GET returns a per-id body.
 */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const DETAILS: Record<string, any> = {
  'ext-1001': {
    jobPostId: 'ext-1001',
    description:
      'Join Van\u2019s Aircraft! The base pay range is $70,000 - $90,000 per year. Email careers@vans.example to apply.',
    workplaceType: 'ONSITE',
  },
  'ext-1002': {
    jobPostId: 'ext-1002',
    description: 'Sell kits nationwide.',
    workplaceType: 'REMOTE',
  },
};

function routedGet(): jest.Mock {
  return mockGet.mockImplementation(async (url: string) => {
    if (url.includes('/api/apply/v2/jobposting/')) {
      const id = url.split('/').pop() as string;
      return { data: DETAILS[id] ?? null };
    }
    return { data: clone(LIST_RESPONSE) };
  });
}

describe('ApponeService — Spec 5036', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    // Default: every detail fetch resolves to null so a list-only test is clean.
    mockGet.mockResolvedValue({ data: null });
  });

  describe('registration scaffolding', () => {
    it('resolves through ApponeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApponeModule],
      }).compile();
      const service = moduleRef.get(ApponeService);
      expect(service).toBeInstanceOf(ApponeService);
      await moduleRef.close();
    });

    it('exports the Site.APPONE = "appone" enum value', () => {
      expect(Site.APPONE).toBe('appone');
    });

    it('returns empty JobResponseDto when tenant is unresolvable', async () => {
      const service = new ApponeService();
      const result = await service.scrape({} as ScraperInputDto);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('happy path — 3 postings', () => {
    it('maps every posting with company / location / type / date and canonical id', async () => {
      routedGet();

      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
        resultsWanted: 100,
      } as ScraperInputDto);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(3);

      const first = result.jobs[0];
      expect(first.id).toBe('appone-ext-1001');
      expect(first.title).toBe('Quality Assurance Technician');
      expect(first.companyName).toBe("Van's Aircraft, Inc.");
      expect(first.atsType).toBe('appone');
      expect(first.atsId).toBe('ext-1001');
      expect(first.site).toBe(Site.APPONE);
      expect(first.jobUrl).toBe('https://apply.appone.com/job/ext-1001');
      expect(first.location?.city).toBe('Aurora');
      expect(first.location?.state).toBe('OR');
      expect(first.isRemote).toBe(false);
      expect(first.employmentType).toBe('Full Time');
      expect(first.jobType).toEqual([JobType.FULL_TIME]);
      expect(first.datePosted).toEqual(new Date('2026-07-01T17:10:10.2781868Z'));

      // The first GET is the list; boardId path carries the tenant slug.
      const firstUrl = mockGet.mock.calls[0][0] as string;
      expect(firstUrl).toBe(
        'https://jobs.appone.com/api/portal/v1/companyjobposts/vansaircraftcareers',
      );
    });

    it('derives isRemote from workplaceType REMOTE and flags Hybrid', async () => {
      routedGet();
      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
      } as ScraperInputDto);

      const remote = result.jobs.find((j) => j.atsId === 'ext-1002');
      expect(remote?.isRemote).toBe(true);
      expect(remote?.jobType).toEqual([JobType.PART_TIME]);

      const hybrid = result.jobs.find((j) => j.atsId === 'ext-1003');
      expect(hybrid?.isRemote).toBe(false);
      expect(hybrid?.workFromHomeType).toBe('Hybrid');
    });

    it('honours resultsWanted=2 against a 3-posting fixture', async () => {
      routedGet();
      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
        resultsWanted: 2,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('detail overlay', () => {
    it('overlays the plain-text description, emails, and parsed compensation', async () => {
      routedGet();
      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
      } as ScraperInputDto);

      const first = result.jobs.find((j) => j.atsId === 'ext-1001');
      expect(first?.description).toContain('Join Van');
      expect(first?.emails).toEqual(['careers@vans.example']);
      // Free-text pay in the body is parsed into a structured range.
      expect(first?.compensation?.minAmount).toBe(70000);
      expect(first?.compensation?.maxAmount).toBe(90000);

      // A posting with no detail node keeps its list-only fields (no body).
      const noDetail = result.jobs.find((j) => j.atsId === 'ext-1003');
      expect(noDetail?.description ?? null).toBeNull();
      expect(noDetail?.title).toBe('Senior Aerospace Design Engineer');
    });
  });

  describe('companyUrl tenant resolution', () => {
    it('parses the tenant from a jobs.appone.com careers URL', async () => {
      routedGet();
      const service = new ApponeService();
      await service.scrape({
        siteType: [Site.APPONE],
        companyUrl: 'https://jobs.appone.com/vansaircraftcareers',
      } as ScraperInputDto);
      expect(mockGet.mock.calls[0][0]).toBe(
        'https://jobs.appone.com/api/portal/v1/companyjobposts/vansaircraftcareers',
      );
    });
  });

  describe('empty jobPosts', () => {
    it('returns an empty JobResponseDto without throwing', async () => {
      const empty = clone(LIST_RESPONSE);
      (empty as any).jobPosts = [];
      mockGet.mockResolvedValueOnce({ data: empty });

      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
      } as ScraperInputDto);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('HTTP error caught', () => {
    it('returns an empty JobResponseDto on list rejection (never re-throws)', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new ApponeService();
      const result = await service.scrape({
        siteType: [Site.APPONE],
        companySlug: 'vansaircraftcareers',
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
