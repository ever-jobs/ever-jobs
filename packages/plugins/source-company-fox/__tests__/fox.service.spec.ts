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

import { FoxModule, FoxService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'fox-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 149 / T04 — `FoxService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FoxService` through `FoxModule`.
 *   2. `Site.FOX === 'fox'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      FOURTH-COHORT slug-truncation asymmetric wire pin**
 *      (`'Fox Creek Veterinary Hospital - Wildwood'` 40 bytes
 *      vs slug `fox` 3 bytes — slug truncates to first token
 *      of 6-token wire, NEW largest slug-token-truncation
 *      factor); D-10 omitted byte-for-byte title pass-through
 *      (no trim) lock; D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('FoxService — Spec 149 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FoxModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FoxModule],
      }).compile();
      const service = moduleRef.get(FoxService);
      expect(service).toBeInstanceOf(FoxService);
      await moduleRef.close();
    });

    it('exports the Site.FOX = "fox" enum value', () => {
      expect(Site.FOX).toBe('fox');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ext = dto.jobs.find((j) => j.id === 'fox-5040378002');
      expect(ext).toBeDefined();
      expect(ext?.site).toBe(Site.FOX);
      // D-09 slug-truncation asymmetric lock — wire is full
      // 6-token legal entity name; slug is first token only.
      expect(ext?.companyName).toBe('Fox Creek Veterinary Hospital - Wildwood');
      expect(ext?.companyName?.split(' ').length).toBeGreaterThanOrEqual(5);
      expect(ext?.companyName?.split(' ')[0].toLowerCase()).toBe('fox');
      expect(ext?.title).toBe(
        'DVM Student Externship/Preceptorship Program - Fox Creek Veterinary Hospital (Urgent Care)',
      );
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ext?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/fox/jobs/5040378002',
      );
      expect(ext?.jobUrl).toContain('job-boards.greenhouse.io/fox/jobs/');
      // D-11 clean dept pass-through.
      expect(ext?.department).toBe('Externships');
      expect(ext?.location?.city).toBe('Wildwood, MO');
      expect(ext?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ext?.description).not.toContain('&lt;');
      expect(ext?.description).not.toContain('<p>');
      expect(ext?.description).toContain('Fox Creek Veterinary Hospital');

      const rec = dto.jobs.find((j) => j.id === 'fox-8531465002');
      expect(rec).toBeDefined();
      expect(rec?.title).toBe('Veterinary Receptionist');
      expect(rec?.companyName).toBe('Fox Creek Veterinary Hospital - Wildwood');
      expect(rec?.location?.city).toBe('Wildwood, MO');
      expect(rec?.isRemote).toBe(false);
      expect(rec?.department).toBe('Reception');
      expect(rec?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/fox/jobs/8531465002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/fox/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
        searchTerm: 'EXTERNSHIP',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fox-5040378002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
        searchTerm: 'reception',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fox-8531465002');
      expect(result.jobs[0].department).toBe('Reception');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FoxService();
      const result = await service.scrape({
        siteType: [Site.FOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
