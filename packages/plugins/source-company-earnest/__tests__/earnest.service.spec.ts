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

import { EarnestModule, EarnestService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'earnest-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 144 / T04 — `EarnestService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `EarnestService` through `EarnestModule`.
 *   2. `Site.EARNEST === 'earnest'` literal pin.
 *   3. Happy path — **variant-39 URL byte-for-byte lock**
 *      (`app.careerpuck.com/job-board/earnest/job/<id>?gh_jid=<id>`
 *      third-party careers-proxy host); D-09 case-symmetric
 *      `'Earnest'` lock; D-10 trailing-pad title-trim lock;
 *      D-11 trailing-pad dept-trim lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('EarnestService — Spec 144 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through EarnestModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [EarnestModule],
      }).compile();
      const service = moduleRef.get(EarnestService);
      expect(service).toBeInstanceOf(EarnestService);
      await moduleRef.close();
    });

    it('exports the Site.EARNEST = "earnest" enum value', () => {
      expect(Site.EARNEST).toBe('earnest');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'earnest-7863484');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.EARNEST);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Earnest');
      expect(ae?.companyName?.toLowerCase()).toBe('earnest');
      expect(ae?.title).toBe('Analytics Engineer II');
      // D-04 lock — variant 39 (third-party careerpuck.com proxy).
      expect(ae?.jobUrl).toBe(
        'https://app.careerpuck.com/job-board/earnest/job/7863484?gh_jid=7863484',
      );
      expect(ae?.jobUrl).toContain('app.careerpuck.com/job-board/earnest/job/');
      expect(ae?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept (this listing has clean wire dept).
      expect(ae?.department).toBe('Analytics');
      expect(ae?.location?.city).toBe('San Francisco, CA');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).toContain('Earnest');

      const dc = dto.jobs.find((j) => j.id === 'earnest-7875507');
      expect(dc).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Director of Collections ');
      expect(dc?.title).toBe('Director of Collections');
      expect(dc?.title).not.toMatch(/\s$/);
      // D-11 lock — wire dept carries trailing-pad
      // (`'Engineering '`); emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Engineering ');
      expect(dc?.department).toBe('Engineering');
      expect(dc?.department).not.toMatch(/\s$/);
      expect(dc?.companyName).toBe('Earnest');
      expect(dc?.location?.city).toBe('Remote, US');
      expect(dc?.isRemote).toBe(true);
      expect(dc?.jobUrl).toBe(
        'https://app.careerpuck.com/job-board/earnest/job/7875507?gh_jid=7875507',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/earnest/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
        searchTerm: 'COLLECTIONS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('earnest-7875507');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('earnest-7875507');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new EarnestService();
      const result = await service.scrape({
        siteType: [Site.EARNEST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
