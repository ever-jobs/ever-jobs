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

import { GofundmeModule, GofundmeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'gofundme-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 151 / T04 — `GofundmeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `GofundmeService` through `GofundmeModule`.
 *   2. `Site.GOFUNDME === 'gofundme'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      FIRST-COHORT NON-consecutive segment-boundary
 *      THREE-cap PascalCase wire pin** (`'GoFundMe'` 8 bytes;
 *      caps at 0/2/6 — segment boundaries of `Go | Fund | Me`);
 *      D-10 leading-pad title-trim lock; **D-11 trailing-pad
 *      dept-trim lock**.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('GofundmeService — Spec 151 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through GofundmeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GofundmeModule],
      }).compile();
      const service = moduleRef.get(GofundmeService);
      expect(service).toBeInstanceOf(GofundmeService);
      await moduleRef.close();
    });

    it('exports the Site.GOFUNDME = "gofundme" enum value', () => {
      expect(Site.GOFUNDME).toBe('gofundme');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'gofundme-7398335');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.GOFUNDME);
      // D-09 NON-consecutive segment-boundary THREE-cap
      // PascalCase case-asymmetric lock.
      expect(ae?.companyName).toBe('GoFundMe');
      expect(ae?.companyName?.toLowerCase()).toBe('gofundme');
      // Verify caps positions: 0 (G), 2 (F), 6 (M).
      const cn = ae?.companyName ?? '';
      expect(cn[0]).toBe('G');
      expect(cn[2]).toBe('F');
      expect(cn[6]).toBe('M');
      // The segment split: Go | Fund | Me.
      expect(cn.slice(0, 2)).toBe('Go');
      expect(cn.slice(2, 6)).toBe('Fund');
      expect(cn.slice(6)).toBe('Me');
      expect(ae?.title).toBe('Account Executive, Mid-Market');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/gofundme/jobs/7398335',
      );
      // D-11 clean dept (this listing has clean wire dept).
      expect(ae?.department).toBe('Sales');
      expect(ae?.location?.city).toBe('San Diego, CA');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).toContain('GoFundMe');

      const pp = dto.jobs.find((j) => j.id === 'gofundme-7759883');
      expect(pp).toBeDefined();
      // D-10 lock — wire title carries LEADING-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' Privacy Program Manager');
      expect(pp?.title).toBe('Privacy Program Manager');
      expect(pp?.title).not.toMatch(/^\s/);
      // D-11 lock — wire dept carries trailing-pad
      // (`'Technical Solutions & Partnerships '`); emitted
      // dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe(
        'Technical Solutions & Partnerships ',
      );
      expect(pp?.department).toBe('Technical Solutions & Partnerships');
      expect(pp?.department).not.toMatch(/\s$/);
      expect(pp?.companyName).toBe('GoFundMe');
      expect(pp?.location?.city).toBe('Remote, US');
      expect(pp?.isRemote).toBe(true);
      expect(pp?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/gofundme/jobs/7759883',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/gofundme/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
        searchTerm: 'PRIVACY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gofundme-7759883');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
        searchTerm: 'partnerships',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gofundme-7759883');
      expect(result.jobs[0].department).toBe('Technical Solutions & Partnerships');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new GofundmeService();
      const result = await service.scrape({
        siteType: [Site.GOFUNDME],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
