import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, JobType, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { AuroraTechModule, AuroraTechService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'auroratech-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 5102 — AuroraTechService unit tests.
 */
describe('AuroraTechService — Spec 5102', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AuroraTechModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AuroraTechModule],
      }).compile();
      const service = moduleRef.get(AuroraTechService);
      expect(service).toBeInstanceOf(AuroraTechService);
      await moduleRef.close();
    });

    it('exports the Site.AURORA_TECH = "aurora_tech" enum value', () => {
      expect(Site.AURORA_TECH).toBe('aurora_tech');
    });
  });

  describe('happy path', () => {
    it('maps listed fixture jobs to JobPostDto and skips unlisted / empty-title jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === 'aurora_tech-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.AURORA_TECH);
      expect(job0?.companyName).toBe('Aurora');
      expect(job0?.companyUrl).toBe('https://aurora.tech/');
      expect(job0?.title).toBe('Senior Software Engineer');
      expect(job0?.title).not.toMatch(/\s$/);
      expect(job0?.jobUrl).toBe(first.jobUrl);
      expect(job0?.applyUrl).toBe(first.applyUrl);
      expect(job0?.department).toBe('Engineering');
      expect(job0?.team).toBe('Perception');
      expect(job0?.employmentType).toBe('Full-time');
      expect(job0?.isRemote).toBe(false);
      expect(job0?.workFromHomeType).toBe('Hybrid');
      expect(job0?.location?.city).toBe('Pittsburgh');
      expect(job0?.location?.state).toBe('PA');
      expect(job0?.compensation?.minAmount).toBe(180000);
      expect(job0?.compensation?.maxAmount).toBe(220000);
      expect(job0?.compensation?.currency).toBe('USD');
      expect(job0?.compensation?.interval).toBe('yearly');
      expect(job0?.jobType).toContain(JobType.FULL_TIME);
      expect(job0?.datePosted).toBe('2026-08-28');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.ashbyhq.com/posting-api/job-board/aurora-operations-inc?includeCompensation=true',
      );
    });

    it('emits per-site locations[] when a posting lists primary + secondary sites', async () => {
      const raw = clone(JOBS_PAGE_RAW);
      raw.jobs[0].secondaryLocations = [{ location: 'Bozeman, MT' }];
      mockGet.mockResolvedValueOnce({ data: raw });

      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const job0 = result.jobs.find((j) => j.id === 'aurora_tech-job-001');

      expect(job0?.locations).toMatchObject([
        { city: 'Pittsburgh', state: 'PA' },
        { city: 'Bozeman', state: 'MT' },
      ]);
    });

    it('resolves a postalAddress location and remote workplaceType', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const job2 = result.jobs.find((j) => j.id === 'aurora_tech-job-002');
      expect(job2).toBeDefined();
      expect(job2?.isRemote).toBe(true);
      expect(job2?.workFromHomeType).toBe('Remote');
      expect(job2?.location?.city).toBe('San Francisco');
      expect(job2?.location?.state).toBe('CA');
      expect(job2?.datePosted).toBe('2026-08-27');
    });
  });

  describe('company name / URL pass-through', () => {
    it('emits Aurora company metadata for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('Aurora');
        expect(job.companyUrl).toBe('https://aurora.tech/');
        expect(job.site).toBe(Site.AURORA_TECH);
      }
    });
  });

  describe('title trim', () => {
    it('trims surrounding whitespace from titles', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/^\s/);
        expect(job.title).not.toMatch(/\s$/);
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a multi-item board', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('offset', () => {
    it('skips the first N jobs after filters', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        resultsWanted: 100,
        offset: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].id).toBe('aurora_tech-job-002');
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        searchTerm: 'applied researcher',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('aurora_tech-job-002');
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('location filter', () => {
    it('filters by city/state', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        location: 'Seattle',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('aurora_tech-job-003');
    });
  });

  describe('isRemote filter', () => {
    it('returns only remote jobs when isRemote=true', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        isRemote: true,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('aurora_tech-job-002');
    });
  });

  describe('jobType filter', () => {
    it('returns only full-time jobs when jobType=FULL_TIME', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
        jobType: JobType.FULL_TIME,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      for (const job of result.jobs) {
        expect(job.jobType).toContain(JobType.FULL_TIME);
      }
    });
  });

  describe('companySlug override', () => {
    it('uses input.companySlug when supplied', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new AuroraTechService();
      await service.scrape({
        siteType: [Site.AURORA_TECH],
        companySlug: 'aurora-other',
      } as ScraperInputDto);
      expect(mockGet).toHaveBeenCalledWith(
        'https://api.ashbyhq.com/posting-api/job-board/aurora-other?includeCompensation=true',
      );
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 404 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 404'));
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new AuroraTechService();
      const result = await service.scrape({
        siteType: [Site.AURORA_TECH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
