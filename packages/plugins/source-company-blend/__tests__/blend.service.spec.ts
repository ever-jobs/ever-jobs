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

import { BlendModule, BlendService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'blend-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 138 / T04 — `BlendService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BlendService` through `BlendModule`.
 *   2. `Site.BLEND === 'blend'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Blend'` lock; D-10 trailing-pad title
 *      trim lock; **D-11 first-cohort company-suffix dept
 *      naming pass-through lock** (`'Customer Success- Blend
 *      Labs'` byte-for-byte).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BlendService — Spec 138 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BlendModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BlendModule],
      }).compile();
      const service = moduleRef.get(BlendService);
      expect(service).toBeInstanceOf(BlendService);
      await moduleRef.close();
    });

    it('exports the Site.BLEND = "blend" enum value', () => {
      expect(Site.BLEND).toBe('blend');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csm = dto.jobs.find((j) => j.id === 'blend-5818141004');
      expect(csm).toBeDefined();
      expect(csm?.site).toBe(Site.BLEND);
      // D-09 case-symmetric lock.
      expect(csm?.companyName).toBe('Blend');
      expect(csm?.companyName?.toLowerCase()).toBe('blend');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Customer Success Manager ');
      expect(csm?.title).toBe('Customer Success Manager');
      expect(csm?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(csm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/blend/jobs/5818141004',
      );
      expect(csm?.jobUrl).toContain('job-boards.greenhouse.io/blend/jobs/');
      // **D-11 lock — first-cohort company-suffix dept naming
      // convention** preserved byte-for-byte.
      expect(csm?.department).toBe('Customer Success- Blend Labs');
      expect(csm?.department).toMatch(/- Blend Labs$/);
      expect(csm?.location?.city).toBe('San Francisco, CA');
      expect(csm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(csm?.description).not.toContain('&lt;');
      expect(csm?.description).not.toContain('&amp;');
      expect(csm?.description).not.toContain('<p>');
      expect(csm?.description).not.toContain('<strong>');
      expect(csm?.description).toContain('Blend');

      const se = dto.jobs.find((j) => j.id === 'blend-5897234002');
      expect(se).toBeDefined();
      expect(se?.title).toBe('Sales Engineer - Enterprise');
      expect(se?.companyName).toBe('Blend');
      expect(se?.location?.city).toBe('Remote, US');
      expect(se?.isRemote).toBe(true);
      // D-11 lock — second sample with company-suffix
      // convention.
      expect(se?.department).toBe('Sales Engineering- Blend Labs');
      expect(se?.department).toMatch(/- Blend Labs$/);
      expect(se?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/blend/jobs/5897234002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/blend/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('blend-5897234002');
    });

    it('filters by case-insensitive substring of department name (incl. company-suffix)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('blend-5818141004');
      expect(result.jobs[0].department).toBe('Customer Success- Blend Labs');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BlendService();
      const result = await service.scrape({
        siteType: [Site.BLEND],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
