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

import { AxonModule, AxonService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'axon-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 135 / T04 — `AxonService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AxonService` through `AxonModule`.
 *   2. `Site.AXON === 'axon'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Axon'` lock; D-10 trailing-pad title trim
 *      lock; **D-11 second-cohort numeric-prefix-with-space
 *      dept naming pass-through lock + first-cohort internal-
 *      double-whitespace dept observation lock**
 *      (`'1105 SCM - Distribution &  Warehousing - Skybridge'`
 *      preserved byte-for-byte).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AxonService — Spec 135 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AxonModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AxonModule],
      }).compile();
      const service = moduleRef.get(AxonService);
      expect(service).toBeInstanceOf(AxonService);
      await moduleRef.close();
    });

    it('exports the Site.AXON = "axon" enum value', () => {
      expect(Site.AXON).toBe('axon');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'axon-7686866003');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.AXON);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Axon');
      expect(ae?.companyName?.toLowerCase()).toBe('axon');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive, Air (T1200 - Northeast) ');
      expect(ae?.title).toBe('Account Executive, Air (T1200 - Northeast)');
      expect(ae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/axon/jobs/7686866003',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/axon/jobs/');
      // **D-11 lock — second-cohort numeric-prefix-with-space
      // convention + first-cohort internal-double-whitespace
      // anomaly preserved byte-for-byte**.
      expect(ae?.department).toBe('1105 SCM - Distribution &  Warehousing - Skybridge');
      expect(ae?.department).toMatch(/^\d+ /);
      // Internal double-space anomaly preserved.
      expect(ae?.department).toMatch(/&  Warehousing/);
      expect(ae?.location?.city).toBe('Boston, MA');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Axon');

      const sse = dto.jobs.find((j) => j.id === 'axon-7795031002');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Evidence.com');
      expect(sse?.companyName).toBe('Axon');
      expect(sse?.location?.city).toBe('Scottsdale, AZ');
      expect(sse?.isRemote).toBe(false);
      // D-11 lock — second sample with numeric-prefix-with-
      // space convention.
      expect(sse?.department).toBe('1501 Software Services');
      expect(sse?.department).toMatch(/^\d+ /);
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/axon/jobs/7795031002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/axon/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
        searchTerm: 'EVIDENCE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('axon-7795031002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
        searchTerm: 'software services',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('axon-7795031002');
      expect(result.jobs[0].department).toBe('1501 Software Services');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AxonService();
      const result = await service.scrape({
        siteType: [Site.AXON],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
