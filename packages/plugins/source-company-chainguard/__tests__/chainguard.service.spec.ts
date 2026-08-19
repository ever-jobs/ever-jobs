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

import { ChainguardModule, ChainguardService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'chainguard-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 122 / T04 — `ChainguardService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ChainguardService` through `ChainguardModule`.
 *   2. `Site.CHAINGUARD === 'chainguard'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Chainguard'` lock; **D-10 applied with
 *      FIRST-COHORT mixed leading-AND-trailing pad form**
 *      lock (assert trailing-pad title trims AND leading-pad
 *      title trims); D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ChainguardService — Spec 122 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ChainguardModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ChainguardModule],
      }).compile();
      const service = moduleRef.get(ChainguardService);
      expect(service).toBeInstanceOf(ChainguardService);
      await moduleRef.close();
    });

    it('exports the Site.CHAINGUARD = "chainguard" enum value', () => {
      expect(Site.CHAINGUARD).toBe('chainguard');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eae = dto.jobs.find((j) => j.id === 'chainguard-4673977006');
      expect(eae).toBeDefined();
      expect(eae?.site).toBe(Site.CHAINGUARD);
      // D-09 case-symmetric lock.
      expect(eae?.companyName).toBe('Chainguard');
      expect(eae?.companyName?.toLowerCase()).toBe('chainguard');
      // **D-10 lock — TRAILING-pad sub-axis**: wire title
      // carries trailing-space pad; emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Enterprise Account Executive ');
      expect(eae?.title).toBe('Enterprise Account Executive');
      expect(eae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(eae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/chainguard/jobs/4673977006',
      );
      expect(eae?.jobUrl).toContain('job-boards.greenhouse.io/chainguard/jobs/');
      expect(eae?.department).toBe('International Sales');
      expect(eae?.location?.city).toBe('Remote, US');
      expect(eae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(eae?.description).not.toContain('&lt;');
      expect(eae?.description).not.toContain('&amp;');
      expect(eae?.description).not.toContain('<p>');
      expect(eae?.description).not.toContain('<strong>');
      expect(eae?.description).toContain('Chainguard');

      const sse = dto.jobs.find((j) => j.id === 'chainguard-4670626006');
      expect(sse).toBeDefined();
      // **D-10 lock — FIRST-COHORT LEADING-pad sub-axis**:
      // wire title carries leading-space pad; emitted title
      // trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' Senior Software Engineer (Experience)');
      expect(sse?.title).toBe('Senior Software Engineer (Experience)');
      expect(sse?.title).not.toMatch(/^\s/);
      expect(sse?.companyName).toBe('Chainguard');
      expect(sse?.location?.city).toBe('Kirkland, WA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Developer Enablement');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/chainguard/jobs/4670626006',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/chainguard/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title (matches leading-padded title after trim)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
        searchTerm: 'EXPERIENCE',
      } as ScraperInputDto);

      // The leading-padded wire title `' Senior Software
      // Engineer (Experience)'` matches `'EXPERIENCE'` after
      // trim — proves the trim happens BEFORE filter.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('chainguard-4670626006');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('chainguard-4673977006');
      expect(result.jobs[0].department).toBe('International Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ChainguardService();
      const result = await service.scrape({
        siteType: [Site.CHAINGUARD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
