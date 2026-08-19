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

import { IndigoModule, IndigoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'indigo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 157 / T04 — `IndigoService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `IndigoService` through `IndigoModule`.
 *   2. `Site.INDIGO === 'indigo'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Indigo'` lock; D-10 omitted byte-for-byte
 *      title pass-through (no trim) lock; D-11 clean dept
 *      pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('IndigoService — Spec 157 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through IndigoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IndigoModule],
      }).compile();
      const service = moduleRef.get(IndigoService);
      expect(service).toBeInstanceOf(IndigoService);
      await moduleRef.close();
    });

    it('exports the Site.INDIGO = "indigo" enum value', () => {
      expect(Site.INDIGO).toBe('indigo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const fo = dto.jobs.find((j) => j.id === 'indigo-4125318007');
      expect(fo).toBeDefined();
      expect(fo?.site).toBe(Site.INDIGO);
      // D-09 case-symmetric lock.
      expect(fo?.companyName).toBe('Indigo');
      expect(fo?.companyName?.toLowerCase()).toBe('indigo');
      expect(fo?.title).toBe('Future Opportunities');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(fo?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/indigo/jobs/4125318007',
      );
      expect(fo?.jobUrl).toContain('job-boards.greenhouse.io/indigo/jobs/');
      // D-11 clean dept pass-through.
      expect(fo?.department).toBe('People');
      expect(fo?.location?.city).toBe('Boston, MA');
      expect(fo?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(fo?.description).not.toContain('&lt;');
      expect(fo?.description).not.toContain('<p>');
      expect(fo?.description).toContain('Indigo');

      const co = dto.jobs.find((j) => j.id === 'indigo-4125318008');
      expect(co).toBeDefined();
      // D-10 omitted — title byte-for-byte pass-through.
      expect(co?.title).toBe('Senior Carbon Operations Manager');
      expect(co?.companyName).toBe('Indigo');
      expect(co?.location?.city).toBe('Charleston, SC');
      expect(co?.isRemote).toBe(false);
      expect(co?.department).toBe('Carbon Operations');
      expect(co?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/indigo/jobs/4125318008',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/indigo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
        searchTerm: 'CARBON',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('indigo-4125318008');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
        searchTerm: 'people',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('indigo-4125318007');
      expect(result.jobs[0].department).toBe('People');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new IndigoService();
      const result = await service.scrape({
        siteType: [Site.INDIGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
