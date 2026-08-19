import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { SolidPowerModule, SolidPowerService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'solidpower-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 714 / T04 — `SolidPowerService` unit tests (≥ 9 cases).
 */
describe('SolidPowerService — Spec 714 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SolidPowerModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SolidPowerModule],
      }).compile();
      const service = moduleRef.get(SolidPowerService);
      expect(service).toBeInstanceOf(SolidPowerService);
      await moduleRef.close();
    });

    it('exports the Site.SOLID_POWER = "solidpower" enum value', () => {
      expect(Site.SOLID_POWER).toBe('solidpower');
    });
  });

  describe('happy path', () => {
    it('maps all fixture listings to JobPostDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === 'solidpower-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.SOLID_POWER);
      // D-09 wire company_name pass-through.
      expect(job0?.companyName).toBe('Solid Power');
      // D-10 title-trim lock.
      expect(job0?.title).toBe(String(first.title).trim());
      expect(job0?.title).not.toMatch(/\s$/);
      // D-04 variant-2 URL.
      expect(job0?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/solidpower/jobs/' + first.id,
      );
      expect(job0?.jobUrl).toContain('job-boards.greenhouse.io/solidpower/jobs/');
      // D-11 department-trim lock (null-safe: some boards expose no departments).
      const firstDept =
        first.departments && first.departments[0]
          ? String(first.departments[0].name).trim()
          : null;
      expect(job0?.department).toBe(firstDept);
      expect(job0?.location?.city).toBe(first.location.name);
      expect(job0?.isRemote).toBe(
        String(first.location.name).toLowerCase().includes('remote'),
      );
      // D-08 decode-then-strip regression guard.
      expect(job0?.description).not.toContain('&lt;');
      expect(job0?.description).not.toContain('&amp;');
      expect(job0?.description).not.toContain('<p>');
      expect(job0?.description).toContain('Solid Power');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/solidpower/jobs?content=true',
      );
    });
  });

  describe('company_name pass-through', () => {
    it('emits the wire company_name for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('Solid Power');
      }
    });
  });

  describe('D-10 title-trim lock', () => {
    it('trims wire title padding — no emitted title has surrounding whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
      } as ScraperInputDto);
      // Fixture listing[0] carries trailing-pad on the wire title.
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/\s$/);
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/\s$/);
        expect(job.title).not.toMatch(/^\s/);
      }
    });
  });

  describe('D-11 department-trim lock', () => {
    it('emits trimmed department or null', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
      } as ScraperInputDto);
      for (let i = 0; i < result.jobs.length; i++) {
        const wire = JOBS_PAGE_RAW.jobs[i].departments;
        const expected = wire && wire[0] ? String(wire[0].name).trim() : null;
        expect(result.jobs[i].department).toBe(expected);
        if (result.jobs[i].department) {
          expect(result.jobs[i].department).not.toMatch(/\s$/);
          expect(result.jobs[i].department).not.toMatch(/^\s/);
        }
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).trim().toLowerCase();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        'solidpower-' + JOBS_PAGE_RAW.jobs[0].id,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new SolidPowerService();
      const result = await service.scrape({
        siteType: [Site.SOLID_POWER],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
