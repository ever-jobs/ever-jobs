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

import { StockXModule, StockXService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'stockx-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 103 / T04 — `StockXService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `StockXService` through `StockXModule`.
 *   2. `Site.STOCKX === 'stockx'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 PascalCase
 *      TWO-cap (indices 0/5) same-byte-count case-asymmetric
 *      wire `'StockX'`; D-10 clean pass-through; D-11 trailing-
 *      pad dept trim.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('StockXService — Spec 103 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through StockXModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StockXModule],
      }).compile();
      const service = moduleRef.get(StockXService);
      expect(service).toBeInstanceOf(StockXService);
      await moduleRef.close();
    });

    it('exports the Site.STOCKX = "stockx" enum value', () => {
      expect(Site.STOCKX).toBe('stockx');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ap = dto.jobs.find((j) => j.id === 'stockx-8510490002');
      expect(ap).toBeDefined();
      expect(ap?.site).toBe(Site.STOCKX);
      // **D-09 lock — PascalCase TWO-cap (indices 0/5) same-
      // byte-count case-asymmetric wire form**: emitted
      // `companyName === 'StockX'` byte-for-byte (6 bytes).
      // Same byte-count as slug `stockx` (6 bytes) but byte-
      // distinct via case at TWO indices — `'S'` vs `'s'` at
      // index 0 AND `'X'` vs `'x'` at index 5.
      expect(ap?.companyName).toBe('StockX');
      expect(ap?.companyName?.length).toBe(6);
      expect(ap?.companyName?.toLowerCase()).toBe('stockx');
      expect(ap?.companyName?.charCodeAt(0)).toBe(83); // 'S'
      expect(ap?.companyName?.charCodeAt(5)).toBe(88); // 'X'
      expect(ap?.title).toBe('Accounts Payable Specialist');
      // D-04 lock — variant 2.
      expect(ap?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/stockx/jobs/8510490002',
      );
      expect(ap?.jobUrl).toContain('job-boards.greenhouse.io/stockx/jobs/');
      expect(ap?.jobUrl).not.toContain('stockx.com');
      expect(ap?.department).toBe('Finance');
      expect(ap?.location?.city).toBe('Bangalore, India');
      expect(ap?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ap?.description).not.toContain('&lt;');
      expect(ap?.description).not.toContain('&amp;');
      expect(ap?.description).not.toContain('<p>');
      expect(ap?.description).not.toContain('<strong>');
      expect(ap?.description).toContain('StockX');

      const cs = dto.jobs.find((j) => j.id === 'stockx-8465053002');
      expect(cs).toBeDefined();
      expect(cs?.title).toBe('Customer Service Lead');
      expect(cs?.companyName).toBe('StockX');
      // D-11 lock — wire dept carries trailing-space pad;
      // emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Customer Service ');
      expect(cs?.department).toBe('Customer Service');
      expect(cs?.department).not.toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(cs?.department).not.toMatch(/\s$/);
      expect(cs?.location?.city).toBe('Detroit, MI');
      expect(cs?.isRemote).toBe(false);
      expect(cs?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/stockx/jobs/8465053002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/stockx/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
        searchTerm: 'PAYABLE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('stockx-8510490002');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
        searchTerm: 'customer service',
      } as ScraperInputDto);

      // D-11 lock — searchTerm hits TRIMMED dept form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('stockx-8465053002');
      expect(result.jobs[0].department).toBe('Customer Service');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new StockXService();
      const result = await service.scrape({
        siteType: [Site.STOCKX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
