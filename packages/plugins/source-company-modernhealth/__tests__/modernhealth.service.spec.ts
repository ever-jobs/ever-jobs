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

import { ModernHealthModule, ModernHealthService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'modernhealth-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 131 / T04 — `ModernHealthService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ModernHealthService` through `ModernHealthModule`.
 *   2. `Site.MODERNHEALTH === 'modernhealth'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      internal-whitespace asymmetric** `'Modern Health'` lock
 *      (13 bytes / 12-byte slug); D-10 trailing-pad title trim
 *      lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ModernHealthService — Spec 131 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ModernHealthModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ModernHealthModule],
      }).compile();
      const service = moduleRef.get(ModernHealthService);
      expect(service).toBeInstanceOf(ModernHealthService);
      await moduleRef.close();
    });

    it('exports the Site.MODERNHEALTH = "modernhealth" enum value', () => {
      expect(Site.MODERNHEALTH).toBe('modernhealth');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cm = dto.jobs.find((j) => j.id === 'modernhealth-8532568002');
      expect(cm).toBeDefined();
      expect(cm?.site).toBe(Site.MODERNHEALTH);
      // **D-09 internal-whitespace asymmetry lock** — wire
      // `'Modern Health'` 13 bytes (two-token, internal space
      // at byte index 6) vs slug `modernhealth` 12 bytes
      // (concatenated). Eighth internal-whitespace asymmetry
      // case in the cohort.
      expect(cm?.companyName).toBe('Modern Health');
      expect(cm?.companyName?.length).toBe(13);
      expect(cm?.companyName).toContain(' ');
      expect(cm?.companyName?.[6]).toBe(' ');
      expect(cm?.companyName?.replace(/ /g, '').toLowerCase()).toBe('modernhealth');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Client Manager (Singapore) ');
      expect(cm?.title).toBe('Client Manager (Singapore)');
      expect(cm?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(cm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/modernhealth/jobs/8532568002',
      );
      expect(cm?.jobUrl).toContain('job-boards.greenhouse.io/modernhealth/jobs/');
      expect(cm?.department).toBe('Customer Success');
      expect(cm?.location?.city).toBe('Singapore');
      expect(cm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(cm?.description).not.toContain('&lt;');
      expect(cm?.description).not.toContain('&amp;');
      expect(cm?.description).not.toContain('<p>');
      expect(cm?.description).not.toContain('<strong>');
      expect(cm?.description).toContain('Modern Health');

      const sape = dto.jobs.find((j) => j.id === 'modernhealth-8617430005');
      expect(sape).toBeDefined();
      expect(sape?.title).toBe('Staff AI Product Engineer');
      expect(sape?.companyName).toBe('Modern Health');
      expect(sape?.location?.city).toBe('San Francisco, CA');
      expect(sape?.isRemote).toBe(false);
      expect(sape?.department).toBe('Engineering');
      expect(sape?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/modernhealth/jobs/8617430005',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/modernhealth/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
        searchTerm: 'AI PRODUCT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('modernhealth-8617430005');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('modernhealth-8532568002');
      expect(result.jobs[0].department).toBe('Customer Success');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ModernHealthService();
      const result = await service.scrape({
        siteType: [Site.MODERNHEALTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
