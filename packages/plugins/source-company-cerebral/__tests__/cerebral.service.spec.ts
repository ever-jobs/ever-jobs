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

import { CerebralModule, CerebralService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cerebral-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 094 / T04 — `CerebralService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CerebralService` through `CerebralModule`.
 *   2. `Site.CEREBRAL === 'cerebral'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-symm
 *      lock; D-10 trailing-pad trim lock; D-11 clean pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CerebralService — Spec 094 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CerebralModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CerebralModule],
      }).compile();
      const service = moduleRef.get(CerebralService);
      expect(service).toBeInstanceOf(CerebralService);
      await moduleRef.close();
    });

    it('exports the Site.CEREBRAL = "cerebral" enum value', () => {
      expect(Site.CEREBRAL).toBe('cerebral');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ta = dto.jobs.find((j) => j.id === 'cerebral-7711660003');
      expect(ta).toBeDefined();
      expect(ta?.site).toBe(Site.CEREBRAL);
      expect(ta?.companyName).toBe('Cerebral');
      // D-09 case-symmetric lock.
      expect(ta?.companyName?.toLowerCase()).toBe('cerebral');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(
        'Therapy Associate - Connecticut ',
      );
      expect(ta?.title).toBe('Therapy Associate - Connecticut');
      expect(ta?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ta?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(ta?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cerebral/jobs/7711660003',
      );
      expect(ta?.jobUrl).toContain('job-boards.greenhouse.io/cerebral/jobs/');
      expect(ta?.jobUrl).not.toContain('cerebral.com');
      expect(ta?.department).toBe('Behavioral Care');
      expect(ta?.location?.city).toBe('Remote (United States)');
      expect(ta?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ta?.description).not.toContain('&lt;');
      expect(ta?.description).not.toContain('&amp;');
      expect(ta?.description).not.toContain('<p>');
      expect(ta?.description).not.toContain('<strong>');
      expect(ta?.description).toContain('Cerebral');

      const dcp = dto.jobs.find((j) => j.id === 'cerebral-5895663003');
      expect(dcp).toBeDefined();
      expect(dcp?.title).toBe('Direct Care Physician (1099 Contract) - Tennessee');
      expect(dcp?.companyName).toBe('Cerebral');
      expect(dcp?.location?.city).toBe('Tennessee');
      expect(dcp?.isRemote).toBe(false);
      expect(dcp?.department).toBe('Medical Care');
      expect(dcp?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cerebral/jobs/5895663003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cerebral/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
        searchTerm: 'PHYSICIAN',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cerebral-5895663003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
        searchTerm: 'behavioral',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cerebral-7711660003');
      expect(result.jobs[0].department).toBe('Behavioral Care');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CerebralService();
      const result = await service.scrape({
        siteType: [Site.CEREBRAL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
