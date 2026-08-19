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

import { BandwidthModule, BandwidthService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bandwidth-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 109 / T04 — `BandwidthService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BandwidthService` through `BandwidthModule`.
 *   2. `Site.BANDWIDTH === 'bandwidth'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric lock; D-10 trailing-pad title trim; D-11 clean
 *      dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BandwidthService — Spec 109 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BandwidthModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BandwidthModule],
      }).compile();
      const service = moduleRef.get(BandwidthService);
      expect(service).toBeInstanceOf(BandwidthService);
      await moduleRef.close();
    });

    it('exports the Site.BANDWIDTH = "bandwidth" enum value', () => {
      expect(Site.BANDWIDTH).toBe('bandwidth');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ai = dto.jobs.find((j) => j.id === 'bandwidth-7362388');
      expect(ai).toBeDefined();
      expect(ai?.site).toBe(Site.BANDWIDTH);
      // D-09 case-symmetric lock.
      expect(ai?.companyName).toBe('Bandwidth');
      expect(ai?.companyName?.toLowerCase()).toBe('bandwidth');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AI Engineer (Research & Development) ');
      expect(ai?.title).toBe('AI Engineer (Research & Development)');
      expect(ai?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bandwidth/jobs/7362388',
      );
      expect(ai?.jobUrl).toContain('job-boards.greenhouse.io/bandwidth/jobs/');
      expect(ai?.department).toBe('Network Engineering');
      expect(ai?.location?.city).toBe('Raleigh, NC');
      expect(ai?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ai?.description).not.toContain('&lt;');
      expect(ai?.description).not.toContain('&amp;');
      expect(ai?.description).not.toContain('<p>');
      expect(ai?.description).not.toContain('<strong>');
      expect(ai?.description).toContain('Bandwidth');

      const sm = dto.jobs.find((j) => j.id === 'bandwidth-7728132');
      expect(sm).toBeDefined();
      expect(sm?.title).toBe('Senior Marketing Operations Manager');
      expect(sm?.companyName).toBe('Bandwidth');
      expect(sm?.location?.city).toBe('Denver, CO');
      expect(sm?.isRemote).toBe(false);
      expect(sm?.department).toBe('Marketing');
      expect(sm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bandwidth/jobs/7728132',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bandwidth/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
        searchTerm: 'MARKETING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bandwidth-7728132');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
        searchTerm: 'network engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bandwidth-7362388');
      expect(result.jobs[0].department).toBe('Network Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BandwidthService();
      const result = await service.scrape({
        siteType: [Site.BANDWIDTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
