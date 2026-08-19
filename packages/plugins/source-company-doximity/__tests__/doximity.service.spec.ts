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

import { DoximityModule, DoximityService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'doximity-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 127 / T04 — `DoximityService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DoximityService` through `DoximityModule`.
 *   2. `Site.DOXIMITY === 'doximity'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Doximity'` lock; D-10 trailing-pad title
 *      trim lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DoximityService — Spec 127 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DoximityModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DoximityModule],
      }).compile();
      const service = moduleRef.get(DoximityService);
      expect(service).toBeInstanceOf(DoximityService);
      await moduleRef.close();
    });

    it('exports the Site.DOXIMITY = "doximity" enum value', () => {
      expect(Site.DOXIMITY).toBe('doximity');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const da = dto.jobs.find((j) => j.id === 'doximity-7821037');
      expect(da).toBeDefined();
      expect(da?.site).toBe(Site.DOXIMITY);
      // D-09 case-symmetric lock.
      expect(da?.companyName).toBe('Doximity');
      expect(da?.companyName?.toLowerCase()).toBe('doximity');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Data Analyst ');
      expect(da?.title).toBe('Data Analyst');
      expect(da?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(da?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/doximity/jobs/7821037',
      );
      expect(da?.jobUrl).toContain('job-boards.greenhouse.io/doximity/jobs/');
      expect(da?.department).toBe('Data');
      expect(da?.location?.city).toBe('San Francisco, CA');
      expect(da?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(da?.description).not.toContain('&lt;');
      expect(da?.description).not.toContain('&amp;');
      expect(da?.description).not.toContain('<p>');
      expect(da?.description).not.toContain('<strong>');
      expect(da?.description).toContain('Doximity');

      const sse = dto.jobs.find((j) => j.id === 'doximity-7945612');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer II - Android (Kotlin)');
      expect(sse?.companyName).toBe('Doximity');
      expect(sse?.location?.city).toBe('Remote, US');
      expect(sse?.isRemote).toBe(true);
      expect(sse?.department).toBe('Mobile Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/doximity/jobs/7945612',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/doximity/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
        searchTerm: 'KOTLIN',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('doximity-7945612');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
        searchTerm: 'mobile engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('doximity-7945612');
      expect(result.jobs[0].department).toBe('Mobile Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DoximityService();
      const result = await service.scrape({
        siteType: [Site.DOXIMITY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
