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

import { CrestaModule, CrestaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cresta-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 165 / T04 — `CrestaService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CrestaService` through `CrestaModule`.
 *   2. `Site.CRESTA === 'cresta'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Cresta'` lock; D-10 trailing-pad title-
 *      trim lock; D-10 leading-pad sub-axis title-trim
 *      lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error
 *      handling, empty payload.
 */
describe('CrestaService — Spec 165 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CrestaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CrestaModule],
      }).compile();
      const service = moduleRef.get(CrestaService);
      expect(service).toBeInstanceOf(CrestaService);
      await moduleRef.close();
    });

    it('exports the Site.CRESTA = "cresta" enum value', () => {
      expect(Site.CRESTA).toBe('cresta');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const am = dto.jobs.find((j) => j.id === 'cresta-5140718008');
      expect(am).toBeDefined();
      expect(am?.site).toBe(Site.CRESTA);
      // D-09 case-symmetric lock.
      expect(am?.companyName).toBe('Cresta');
      expect(am?.companyName?.toLowerCase()).toBe('cresta');
      // D-10 trailing-pad lock — wire title carries trailing-
      // space pad; emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Manager ');
      expect(am?.title).toBe('Account Manager');
      expect(am?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(am?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cresta/jobs/5140718008',
      );
      expect(am?.jobUrl).toContain('job-boards.greenhouse.io/cresta/jobs/');
      // D-11 clean dept pass-through.
      expect(am?.department).toBe('Sales');
      expect(am?.location?.city).toBe('United States');
      // D-08 regression guard.
      expect(am?.description).not.toContain('&lt;');
      expect(am?.description).not.toContain('&amp;');
      expect(am?.description).not.toContain('<p>');
      expect(am?.description).not.toContain('<strong>');
      expect(am?.description).toContain('Cresta');

      const ds = dto.jobs.find((j) => j.id === 'cresta-5140719008');
      expect(ds).toBeDefined();
      expect(ds?.title).toBe('Applied Data Scientist');
      expect(ds?.companyName).toBe('Cresta');
      expect(ds?.location?.city).toBe('Remote, US');
      expect(ds?.isRemote).toBe(true);
      expect(ds?.department).toBe('Engineering');
      expect(ds?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cresta/jobs/5140719008',
      );

      // D-10 leading-pad sub-axis lock — wire title carries
      // leading-only-space pad; emitted title trimmed.
      const pm = dto.jobs.find((j) => j.id === 'cresta-5140720008');
      expect(pm).toBeDefined();
      expect(JOBS_PAGE_RAW.jobs[2].title).toBe(' Senior Product Manager');
      expect(pm?.title).toBe('Senior Product Manager');
      expect(pm?.title).not.toMatch(/^\s/);
      expect(pm?.title).not.toMatch(/\s$/);
      expect(pm?.department).toBe('Product');
      expect(pm?.location?.city).toBe('San Francisco, CA');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cresta/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=2 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
        resultsWanted: 2,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
        searchTerm: 'DATA',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cresta-5140719008');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cresta-5140718008');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CrestaService();
      const result = await service.scrape({
        siteType: [Site.CRESTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
