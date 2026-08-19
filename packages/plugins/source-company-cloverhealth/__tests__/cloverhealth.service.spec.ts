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

import { CloverhealthModule, CloverhealthService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cloverhealth-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 555 / T04 — `CloverhealthService` unit tests (≥ 9 cases).
 */
describe('CloverhealthService — Spec 555 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CloverhealthModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CloverhealthModule],
      }).compile();
      const service = moduleRef.get(CloverhealthService);
      expect(service).toBeInstanceOf(CloverhealthService);
      await moduleRef.close();
    });

    it('exports the Site.CLOVER_HEALTH = "cloverhealth" enum value', () => {
      expect(Site.CLOVER_HEALTH).toBe('cloverhealth');
    });
  });

  describe('happy path', () => {
    it('maps all fixture listings to JobPostDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === 'cloverhealth-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.CLOVER_HEALTH);
      // D-09 wire company_name pass-through.
      expect(job0?.companyName).toBe('Clover Health');
      // D-10 title-trim lock.
      expect(job0?.title).toBe(String(first.title).trim());
      expect(job0?.title).not.toMatch(/\s$/);
      // D-04 variant-2 URL.
      expect(job0?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cloverhealth/jobs/' + first.id,
      );
      expect(job0?.jobUrl).toContain('job-boards.greenhouse.io/cloverhealth/jobs/');
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
      expect(job0?.description).toContain('Clover Health');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cloverhealth/jobs?content=true',
      );
    });
  });

  describe('company_name pass-through', () => {
    it('emits the wire company_name for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('Clover Health');
      }
    });
  });

  describe('D-10 title-trim lock', () => {
    it('trims wire title padding — no emitted title has surrounding whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
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
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
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
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new CloverhealthService();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).trim().toLowerCase();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        'cloverhealth-' + JOBS_PAGE_RAW.jobs[0].id,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new CloverhealthService();
      const result = await service.scrape({
        siteType: [Site.CLOVER_HEALTH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
