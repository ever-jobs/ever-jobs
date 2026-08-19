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

import { PlanetScaleModule, PlanetScaleService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'planetscale-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 101 / T04 — `PlanetScaleService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `PlanetScaleService` through `PlanetScaleModule`.
 *   2. `Site.PLANETSCALE === 'planetscale'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 PascalCase
 *      case-asymmetric same-byte-count lock; D-10/D-11 clean
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('PlanetScaleService — Spec 101 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through PlanetScaleModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PlanetScaleModule],
      }).compile();
      const service = moduleRef.get(PlanetScaleService);
      expect(service).toBeInstanceOf(PlanetScaleService);
      await moduleRef.close();
    });

    it('exports the Site.PLANETSCALE = "planetscale" enum value', () => {
      expect(Site.PLANETSCALE).toBe('planetscale');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bd = dto.jobs.find((j) => j.id === 'planetscale-4129420009');
      expect(bd).toBeDefined();
      expect(bd?.site).toBe(Site.PLANETSCALE);
      // **D-09 lock — PascalCase case-asymmetric same-byte-count
      // wire form**: emitted `companyName === 'PlanetScale'`
      // byte-for-byte (11 bytes); same byte-count as slug
      // `planetscale` (11 bytes) but byte-distinct via case at
      // byte index 6 — `'S'` vs `'s'`.
      expect(bd?.companyName).toBe('PlanetScale');
      expect(bd?.companyName?.length).toBe(11);
      expect(bd?.companyName?.toLowerCase()).toBe('planetscale');
      expect(bd?.companyName).not.toBe(bd?.companyName?.toLowerCase());
      expect(bd?.title).toBe('Brand Designer');
      // D-04 lock — variant 2.
      expect(bd?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/planetscale/jobs/4129420009',
      );
      expect(bd?.jobUrl).toContain(
        'job-boards.greenhouse.io/planetscale/jobs/',
      );
      expect(bd?.jobUrl).not.toContain('planetscale.com');
      expect(bd?.department).toBe('Marketing');
      expect(bd?.location?.city).toBe('Remote, US');
      expect(bd?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(bd?.description).not.toContain('&lt;');
      expect(bd?.description).not.toContain('&amp;');
      expect(bd?.description).not.toContain('<p>');
      expect(bd?.description).not.toContain('<strong>');
      expect(bd?.description).toContain('PlanetScale');

      const se = dto.jobs.find((j) => j.id === 'planetscale-4036240009');
      expect(se).toBeDefined();
      expect(se?.title).toBe('Software Engineer - Infrastructure');
      expect(se?.companyName).toBe('PlanetScale');
      expect(se?.location?.city).toBe('Remote, US');
      expect(se?.isRemote).toBe(true);
      expect(se?.department).toBe('Engineering');
      expect(se?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/planetscale/jobs/4036240009',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/planetscale/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
        searchTerm: 'INFRASTRUCTURE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('planetscale-4036240009');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('planetscale-4129420009');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new PlanetScaleService();
      const result = await service.scrape({
        siteType: [Site.PLANETSCALE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
