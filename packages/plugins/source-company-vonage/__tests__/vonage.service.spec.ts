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

import { VonageModule, VonageService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'vonage-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 119 / T04 — `VonageService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `VonageService` through `VonageModule`.
 *   2. `Site.VONAGE === 'vonage'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Vonage'` lock; D-10 trailing-pad title trim;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('VonageService — Spec 119 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through VonageModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [VonageModule],
      }).compile();
      const service = moduleRef.get(VonageService);
      expect(service).toBeInstanceOf(VonageService);
      await moduleRef.close();
    });

    it('exports the Site.VONAGE = "vonage" enum value', () => {
      expect(Site.VONAGE).toBe('vonage');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const em = dto.jobs.find((j) => j.id === 'vonage-8106011002');
      expect(em).toBeDefined();
      expect(em?.site).toBe(Site.VONAGE);
      // D-09 case-symmetric lock.
      expect(em?.companyName).toBe('Vonage');
      expect(em?.companyName?.toLowerCase()).toBe('vonage');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Engineering Manager ');
      expect(em?.title).toBe('Engineering Manager');
      expect(em?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(em?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/vonage/jobs/8106011002',
      );
      expect(em?.jobUrl).toContain('job-boards.greenhouse.io/vonage/jobs/');
      expect(em?.department).toBe('API BU Engineering');
      expect(em?.location?.city).toBe('London, UK');
      expect(em?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(em?.description).not.toContain('&lt;');
      expect(em?.description).not.toContain('&amp;');
      expect(em?.description).not.toContain('<p>');
      expect(em?.description).not.toContain('<strong>');
      expect(em?.description).toContain('Vonage');

      const sbe = dto.jobs.find((j) => j.id === 'vonage-8221739003');
      expect(sbe).toBeDefined();
      expect(sbe?.title).toBe('Senior Backend Engineer, Communications APIs');
      expect(sbe?.companyName).toBe('Vonage');
      expect(sbe?.location?.city).toBe('Wrocław, Poland');
      expect(sbe?.isRemote).toBe(false);
      expect(sbe?.department).toBe('Apps BU Engineering');
      expect(sbe?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/vonage/jobs/8221739003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/vonage/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
        searchTerm: 'BACKEND',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('vonage-8221739003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
        searchTerm: 'api bu',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('vonage-8106011002');
      expect(result.jobs[0].department).toBe('API BU Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new VonageService();
      const result = await service.scrape({
        siteType: [Site.VONAGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
