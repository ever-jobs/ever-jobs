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

import { TatariModule, TatariService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'tatari-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 173 / T04 — `TatariService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `TatariService` through `TatariModule`.
 *   2. `Site.TATARI === 'tatari'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      case-symmetric bare-brand wire pin** (`'Tatari'` 6
 *      bytes; case-symmetric); D-10 trailing-pad title-trim
 *      lock; D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('TatariService — Spec 173 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through TatariModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TatariModule],
      }).compile();
      const service = moduleRef.get(TatariService);
      expect(service).toBeInstanceOf(TatariService);
      await moduleRef.close();
    });

    it('exports the Site.TATARI = "tatari" enum value', () => {
      expect(Site.TATARI).toBe('tatari');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const dsa = dto.jobs.find((j) => j.id === 'tatari-8120341002');
      expect(dsa).toBeDefined();
      expect(dsa?.site).toBe(Site.TATARI);
      // D-09 case-symmetric bare-brand wire lock.
      expect(dsa?.companyName).toBe('Tatari');
      expect(dsa?.companyName?.toLowerCase()).toBe('tatari');
      expect(dsa?.companyName).toHaveLength(6);
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Data Science Analyst ');
      expect(dsa?.title).toBe('Data Science Analyst');
      expect(dsa?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(dsa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/tatari/jobs/8120341002',
      );
      expect(dsa?.jobUrl).toContain('job-boards.greenhouse.io/tatari/jobs/');
      // D-11 clean dept pass-through.
      expect(dsa?.department).toBe('Data Science');
      expect(dsa?.location?.city).toBe('San Francisco, CA');
      expect(dsa?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(dsa?.description).not.toContain('&lt;');
      expect(dsa?.description).not.toContain('&amp;');
      expect(dsa?.description).not.toContain('<p>');
      expect(dsa?.description).toContain('Tatari');

      const sse = dto.jobs.find((j) => j.id === 'tatari-8481616002');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      expect(sse?.companyName).toBe('Tatari');
      expect(sse?.location?.city).toBe('Remote, US');
      expect(sse?.isRemote).toBe(true);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/tatari/jobs/8481616002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/tatari/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
        searchTerm: 'PLATFORM',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('tatari-8481616002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
        searchTerm: 'data science',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('tatari-8120341002');
      expect(result.jobs[0].department).toBe('Data Science');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new TatariService();
      const result = await service.scrape({
        siteType: [Site.TATARI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
