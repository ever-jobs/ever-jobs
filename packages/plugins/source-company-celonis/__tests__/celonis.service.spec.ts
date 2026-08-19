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

import { CelonisModule, CelonisService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'celonis-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 140 / T04 — `CelonisService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CelonisService` through `CelonisModule`.
 *   2. `Site.CELONIS === 'celonis'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Celonis'` lock; **D-10 third-cohort
 *      leading-pad observation lock + trailing-pad lock**;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CelonisService — Spec 140 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CelonisModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CelonisModule],
      }).compile();
      const service = moduleRef.get(CelonisService);
      expect(service).toBeInstanceOf(CelonisService);
      await moduleRef.close();
    });

    it('exports the Site.CELONIS = "celonis" enum value', () => {
      expect(Site.CELONIS).toBe('celonis');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bd = dto.jobs.find((j) => j.id === 'celonis-7657936003');
      expect(bd).toBeDefined();
      expect(bd?.site).toBe(Site.CELONIS);
      // D-09 case-symmetric lock.
      expect(bd?.companyName).toBe('Celonis');
      expect(bd?.companyName?.toLowerCase()).toBe('celonis');
      // D-10 trailing-pad lock — wire title carries trailing
      // single-ASCII-space; `.trim()` strips it.
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/ $/);
      expect(bd?.title).toBe('Business Development Manager');
      expect(bd?.title).not.toMatch(/ $/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(bd?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/celonis/jobs/7657936003',
      );
      expect(bd?.jobUrl).toContain('job-boards.greenhouse.io/celonis/jobs/');
      // D-11 clean dept pass-through.
      expect(bd?.department).toBe('Sales');
      expect(bd?.location?.city).toBe('Munich, Germany');
      expect(bd?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(bd?.description).not.toContain('&lt;');
      expect(bd?.description).not.toContain('&amp;');
      expect(bd?.description).not.toContain('<p>');
      expect(bd?.description).toContain('Celonis');

      const cto = dto.jobs.find((j) => j.id === 'celonis-6094078003');
      expect(cto).toBeDefined();
      // D-10 THIRD-COHORT leading-pad observation lock — wire
      // title `' Field CTO'` carries a leading single-ASCII-
      // space; `.trim()` strips it. After Chainguard (Spec 122
      // — leading-only first observation) and Oscar (Spec 133
      // — 1 leading + 1 trailing). Celonis is the **first
      // cohort plugin to observe leading-pad at meaningful
      // volume** (3 leading samples in the run-350 probe).
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/^ /);
      expect(cto?.title).toBe('Field CTO');
      expect(cto?.title).not.toMatch(/^ /);
      expect(cto?.companyName).toBe('Celonis');
      expect(cto?.location?.city).toBe('Remote, US');
      expect(cto?.isRemote).toBe(true);
      // D-11 clean dept pass-through (multi-token form).
      expect(cto?.department).toBe('Value Engineering');
      expect(cto?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/celonis/jobs/6094078003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/celonis/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
        searchTerm: 'CTO',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('celonis-6094078003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
        searchTerm: 'value engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('celonis-6094078003');
      expect(result.jobs[0].department).toBe('Value Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CelonisService();
      const result = await service.scrape({
        siteType: [Site.CELONIS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
