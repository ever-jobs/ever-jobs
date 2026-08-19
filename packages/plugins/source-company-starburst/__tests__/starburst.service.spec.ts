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

import { StarburstModule, StarburstService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'starburst-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 134 / T04 — `StarburstService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `StarburstService` through `StarburstModule`.
 *   2. `Site.STARBURST === 'starburst'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Starburst'` lock; D-10 trailing-pad title
 *      trim lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('StarburstService — Spec 134 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through StarburstModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StarburstModule],
      }).compile();
      const service = moduleRef.get(StarburstService);
      expect(service).toBeInstanceOf(StarburstService);
      await moduleRef.close();
    });

    it('exports the Site.STARBURST = "starburst" enum value', () => {
      expect(Site.STARBURST).toBe('starburst');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const psa = dto.jobs.find((j) => j.id === 'starburst-5119301008');
      expect(psa).toBeDefined();
      expect(psa?.site).toBe(Site.STARBURST);
      // D-09 case-symmetric lock.
      expect(psa?.companyName).toBe('Starburst');
      expect(psa?.companyName?.toLowerCase()).toBe('starburst');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Partner Solution Architect ');
      expect(psa?.title).toBe('Partner Solution Architect');
      expect(psa?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(psa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/starburst/jobs/5119301008',
      );
      expect(psa?.jobUrl).toContain('job-boards.greenhouse.io/starburst/jobs/');
      expect(psa?.department).toBe('Presales');
      expect(psa?.location?.city).toBe('Boston, MA');
      expect(psa?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(psa?.description).not.toContain('&lt;');
      expect(psa?.description).not.toContain('&amp;');
      expect(psa?.description).not.toContain('<p>');
      expect(psa?.description).not.toContain('<strong>');
      expect(psa?.description).toContain('Starburst');

      const sse = dto.jobs.find((j) => j.id === 'starburst-5234718002');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Galaxy');
      expect(sse?.companyName).toBe('Starburst');
      expect(sse?.location?.city).toBe('Warsaw, Poland');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/starburst/jobs/5234718002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/starburst/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
        searchTerm: 'GALAXY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('starburst-5234718002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
        searchTerm: 'presales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('starburst-5119301008');
      expect(result.jobs[0].department).toBe('Presales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new StarburstService();
      const result = await service.scrape({
        siteType: [Site.STARBURST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
