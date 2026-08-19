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

import { BloomreachModule, BloomreachService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bloomreach-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 139 / T04 — `BloomreachService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BloomreachService` through `BloomreachModule`.
 *   2. `Site.BLOOMREACH === 'bloomreach'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Bloomreach'` lock; **D-10 first-cohort
 *      mojibake-NBSP trailing-pad lock**; D-11 clean dept
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BloomreachService — Spec 139 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BloomreachModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BloomreachModule],
      }).compile();
      const service = moduleRef.get(BloomreachService);
      expect(service).toBeInstanceOf(BloomreachService);
      await moduleRef.close();
    });

    it('exports the Site.BLOOMREACH = "bloomreach" enum value', () => {
      expect(Site.BLOOMREACH).toBe('bloomreach');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ai = dto.jobs.find((j) => j.id === 'bloomreach-7422343');
      expect(ai).toBeDefined();
      expect(ai?.site).toBe(Site.BLOOMREACH);
      // D-09 case-symmetric lock.
      expect(ai?.companyName).toBe('Bloomreach');
      expect(ai?.companyName?.toLowerCase()).toBe('bloomreach');
      expect(ai?.title).toBe('AI Customer Lifecycle Manager');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bloomreach/jobs/7422343',
      );
      expect(ai?.jobUrl).toContain('job-boards.greenhouse.io/bloomreach/jobs/');
      // D-11 clean dept pass-through.
      expect(ai?.department).toBe('Marketing');
      expect(ai?.location?.city).toBe('Slovakia');
      expect(ai?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ai?.description).not.toContain('&lt;');
      expect(ai?.description).not.toContain('&amp;');
      expect(ai?.description).not.toContain('<p>');
      expect(ai?.description).toContain('Bloomreach');

      const sec = dto.jobs.find((j) => j.id === 'bloomreach-7814234');
      expect(sec).toBeDefined();
      // D-10 lock — wire title carries trailing mojibake-NBSP
      // pad (`c3 82 c2 a0`); `.trim()` strips the trailing
      // NBSP (U+00A0); the residual `Â` (U+00C2) byte
      // remains by-design — wire-faithful.
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/Â $/);
      expect(sec?.title).toBe('Senior Security & Compliance AnalystÂ');
      // Trim removed the trailing NBSP.
      expect(sec?.title).not.toMatch(/ $/);
      // But the residual mojibake `Â` remains.
      expect(sec?.title).toMatch(/Â$/);
      expect(sec?.companyName).toBe('Bloomreach');
      expect(sec?.location?.city).toBe('Remote, US');
      expect(sec?.isRemote).toBe(true);
      // D-11 clean dept pass-through (with ampersand).
      expect(sec?.department).toBe('G&A - GIST');
      expect(sec?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bloomreach/jobs/7814234',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bloomreach/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
        searchTerm: 'CUSTOMER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bloomreach-7422343');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
        searchTerm: 'g&a',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bloomreach-7814234');
      expect(result.jobs[0].department).toBe('G&A - GIST');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BloomreachService();
      const result = await service.scrape({
        siteType: [Site.BLOOMREACH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
