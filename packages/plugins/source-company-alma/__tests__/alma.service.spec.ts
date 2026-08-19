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

import { AlmaModule, AlmaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'alma-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 152 / T04 — `AlmaService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AlmaService` through `AlmaModule`.
 *   2. `Site.ALMA === 'alma'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Alma'` lock; D-10 trailing-pad title-trim
 *      lock; D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AlmaService — Spec 152 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AlmaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AlmaModule],
      }).compile();
      const service = moduleRef.get(AlmaService);
      expect(service).toBeInstanceOf(AlmaService);
      await moduleRef.close();
    });

    it('exports the Site.ALMA = "alma" enum value', () => {
      expect(Site.ALMA).toBe('alma');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bi = dto.jobs.find((j) => j.id === 'alma-8515071002');
      expect(bi).toBeDefined();
      expect(bi?.site).toBe(Site.ALMA);
      // D-09 case-symmetric lock.
      expect(bi?.companyName).toBe('Alma');
      expect(bi?.companyName?.toLowerCase()).toBe('alma');
      expect(bi?.title).toBe('Business Intelligence Group Manager, Ops & CX');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(bi?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/alma/jobs/8515071002',
      );
      expect(bi?.jobUrl).toContain('job-boards.greenhouse.io/alma/jobs/');
      // D-11 clean dept pass-through.
      expect(bi?.department).toBe('Business Intelligence');
      expect(bi?.location?.city).toBe('New York, NY');
      expect(bi?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(bi?.description).not.toContain('&lt;');
      expect(bi?.description).not.toContain('<p>');
      expect(bi?.description).toContain('Alma');

      const ds = dto.jobs.find((j) => j.id === 'alma-8525462002');
      expect(ds).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Data Scientist ');
      expect(ds?.title).toBe('Senior Data Scientist');
      expect(ds?.title).not.toMatch(/\s$/);
      expect(ds?.companyName).toBe('Alma');
      expect(ds?.location?.city).toBe('Remote, US');
      expect(ds?.isRemote).toBe(true);
      expect(ds?.department).toBe('Data Science');
      expect(ds?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/alma/jobs/8525462002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/alma/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
        searchTerm: 'SCIENTIST',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('alma-8525462002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
        searchTerm: 'business intelligence',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('alma-8515071002');
      expect(result.jobs[0].department).toBe('Business Intelligence');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AlmaService();
      const result = await service.scrape({
        siteType: [Site.ALMA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
