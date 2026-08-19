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

import { MisfitsMarketModule, MisfitsMarketService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'misfitsmarket-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 098 / T04 — `MisfitsMarketService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MisfitsMarketService` through `MisfitsMarketModule`.
 *   2. `Site.MISFITSMARKET === 'misfitsmarket'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 internal-
 *      whitespace asymmetry lock; D-10 trailing-pad title trim;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('MisfitsMarketService — Spec 098 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MisfitsMarketModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MisfitsMarketModule],
      }).compile();
      const service = moduleRef.get(MisfitsMarketService);
      expect(service).toBeInstanceOf(MisfitsMarketService);
      await moduleRef.close();
    });

    it('exports the Site.MISFITSMARKET = "misfitsmarket" enum value', () => {
      expect(Site.MISFITSMARKET).toBe('misfitsmarket');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const lo = dto.jobs.find((j) => j.id === 'misfitsmarket-6997769003');
      expect(lo).toBeDefined();
      expect(lo?.site).toBe(Site.MISFITSMARKET);
      // **D-09 lock — internal-whitespace asymmetry**: emitted
      // `companyName === 'Misfits Market'` byte-for-byte (14
      // bytes — two-word brand with internal ASCII space at
      // index 7); slug `misfitsmarket` is 13 bytes — case-AND
      // length-asymmetric vs wire.
      expect(lo?.companyName).toBe('Misfits Market');
      expect(lo?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(lo?.companyName).toContain(' '); // internal whitespace
      expect(lo?.companyName?.length).toBe(14);
      expect(lo?.companyName?.replace(/ /g, '').toLowerCase()).toBe(
        'misfitsmarket',
      );
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('1st Shift - Load-out Associate ');
      expect(lo?.title).toBe('1st Shift - Load-out Associate');
      expect(lo?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(lo?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(lo?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/misfitsmarket/jobs/6997769003',
      );
      expect(lo?.jobUrl).toContain(
        'job-boards.greenhouse.io/misfitsmarket/jobs/',
      );
      expect(lo?.jobUrl).not.toContain('misfitsmarket.com');
      expect(lo?.department).toBe('Distribution');
      expect(lo?.location?.city).toBe('Northlake IL');
      expect(lo?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(lo?.description).not.toContain('&lt;');
      expect(lo?.description).not.toContain('&amp;');
      expect(lo?.description).not.toContain('<p>');
      expect(lo?.description).not.toContain('<strong>');
      expect(lo?.description).toContain('Misfits Market');

      const dpm = dto.jobs.find((j) => j.id === 'misfitsmarket-7640527003');
      expect(dpm).toBeDefined();
      expect(dpm?.title).toBe('Director, Performance Marketing');
      expect(dpm?.companyName).toBe('Misfits Market');
      expect(dpm?.location?.city).toBe('Remote');
      expect(dpm?.isRemote).toBe(true);
      expect(dpm?.department).toBe('Marketing');
      expect(dpm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/misfitsmarket/jobs/7640527003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/misfitsmarket/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
        searchTerm: 'DIRECTOR',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('misfitsmarket-7640527003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
        searchTerm: 'distribution',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('misfitsmarket-6997769003');
      expect(result.jobs[0].department).toBe('Distribution');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MisfitsMarketService();
      const result = await service.scrape({
        siteType: [Site.MISFITSMARKET],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
