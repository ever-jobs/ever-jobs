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

import { RechargeModule, RechargeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'recharge-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 167 / T04 — `RechargeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `RechargeService` through `RechargeModule`.
 *   2. `Site.RECHARGE === 'recharge'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Recharge'` lock; D-10 clean title pass-
 *      through; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('RechargeService — Spec 167 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through RechargeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [RechargeModule],
      }).compile();
      const service = moduleRef.get(RechargeService);
      expect(service).toBeInstanceOf(RechargeService);
      await moduleRef.close();
    });

    it('exports the Site.RECHARGE = "recharge" enum value', () => {
      expect(Site.RECHARGE).toBe('recharge');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const em = dto.jobs.find((j) => j.id === 'recharge-8500780002');
      expect(em).toBeDefined();
      expect(em?.site).toBe(Site.RECHARGE);
      // D-09 case-symmetric lock.
      expect(em?.companyName).toBe('Recharge');
      expect(em?.companyName?.toLowerCase()).toBe('recharge');
      // D-10 omitted lock — wire title is clean.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Engineering Manager, Merchant Experience');
      expect(em?.title).toBe('Engineering Manager, Merchant Experience');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(em?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/recharge/jobs/8500780002',
      );
      expect(em?.jobUrl).toContain('job-boards.greenhouse.io/recharge/jobs/');
      // D-11 clean dept pass-through.
      expect(em?.department).toBe('Engineering General');
      expect(em?.location?.city).toBe('Remote, US');
      expect(em?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(em?.description).not.toContain('&lt;');
      expect(em?.description).not.toContain('&amp;');
      expect(em?.description).not.toContain('<p>');
      expect(em?.description).not.toContain('<strong>');
      expect(em?.description).toContain('Recharge');

      const sf = dto.jobs.find((j) => j.id === 'recharge-8464966002');
      expect(sf).toBeDefined();
      expect(sf?.title).toBe('Strategic Finance Senior Analyst, GTM');
      expect(sf?.companyName).toBe('Recharge');
      expect(sf?.location?.city).toBe('Santa Monica, CA');
      expect(sf?.isRemote).toBe(false);
      expect(sf?.department).toBe('FP&A');
      expect(sf?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/recharge/jobs/8464966002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/recharge/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
        searchTerm: 'STRATEGIC',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('recharge-8464966002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('recharge-8500780002');
      expect(result.jobs[0].department).toBe('Engineering General');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new RechargeService();
      const result = await service.scrape({
        siteType: [Site.RECHARGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
