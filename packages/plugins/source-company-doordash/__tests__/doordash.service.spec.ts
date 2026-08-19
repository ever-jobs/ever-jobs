import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture
// rather than the live Greenhouse public API.
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

import { DoorDashModule, DoorDashService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'doordash-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 024 / T04 — `DoorDashService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DoorDashService` through `DoorDashModule`.
 *   2. `Site.DOORDASH === 'doordash'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DoorDashService — Spec 024 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DoorDashModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DoorDashModule],
      }).compile();
      const service = moduleRef.get(DoorDashService);
      expect(service).toBeInstanceOf(DoorDashService);
      await moduleRef.close();
    });

    it('exports the Site.DOORDASH = "doordash" enum value', () => {
      expect(Site.DOORDASH).toBe('doordash');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoorDashService();
      const input: ScraperInputDto = {
        siteType: [Site.DOORDASH],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const logistics = dto.jobs.find((j) => j.id === 'doordash-7401234');
      expect(logistics).toBeDefined();
      expect(logistics?.site).toBe(Site.DOORDASH);
      expect(logistics?.companyName).toBe('DoorDash');
      expect(logistics?.title).toBe('Senior Software Engineer, Logistics Platform');
      expect(logistics?.jobUrl).toBe(
        'https://boards.greenhouse.io/doordash/jobs/7401234',
      );
      expect(logistics?.location?.city).toBe('San Francisco, CA');
      expect(logistics?.department).toBe('Engineering');
      expect(logistics?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(logistics?.description).not.toContain('<p>');
      expect(logistics?.description).toContain('dispatch');

      const ops = dto.jobs.find((j) => j.id === 'doordash-7402345');
      expect(ops?.isRemote).toBe(true);
      expect(ops?.department).toBe('Strategy & Operations');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/doordash/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoorDashService();
      const input: ScraperInputDto = {
        siteType: [Site.DOORDASH],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoorDashService();
      const result = await service.scrape({
        siteType: [Site.DOORDASH],
        searchTerm: 'LOGISTICS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('doordash-7401234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DoorDashService();
      const result = await service.scrape({
        siteType: [Site.DOORDASH],
        searchTerm: 'strategy',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('doordash-7402345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DoorDashService();
      const result = await service.scrape({
        siteType: [Site.DOORDASH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DoorDashService();
      const result = await service.scrape({
        siteType: [Site.DOORDASH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
