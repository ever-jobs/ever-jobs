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

import { AirbnbModule, AirbnbService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'airbnb-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 025 / T04 — `AirbnbService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AirbnbService` through `AirbnbModule`.
 *   2. `Site.AIRBNB === 'airbnb'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('AirbnbService — Spec 025 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AirbnbModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AirbnbModule],
      }).compile();
      const service = moduleRef.get(AirbnbService);
      expect(service).toBeInstanceOf(AirbnbService);
      await moduleRef.close();
    });

    it('exports the Site.AIRBNB = "airbnb" enum value', () => {
      expect(Site.AIRBNB).toBe('airbnb');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirbnbService();
      const input: ScraperInputDto = {
        siteType: [Site.AIRBNB],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const trust = dto.jobs.find((j) => j.id === 'airbnb-7501234');
      expect(trust).toBeDefined();
      expect(trust?.site).toBe(Site.AIRBNB);
      expect(trust?.companyName).toBe('Airbnb');
      expect(trust?.title).toBe('Senior Software Engineer, Trust & Safety Platform');
      expect(trust?.jobUrl).toBe(
        'https://boards.greenhouse.io/airbnb/jobs/7501234',
      );
      expect(trust?.location?.city).toBe('San Francisco, CA');
      expect(trust?.department).toBe('Engineering');
      expect(trust?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(trust?.description).not.toContain('<p>');
      expect(trust?.description).toContain('fraud');

      const stays = dto.jobs.find((j) => j.id === 'airbnb-7502345');
      expect(stays?.isRemote).toBe(true);
      expect(stays?.department).toBe('Design');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/airbnb/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirbnbService();
      const input: ScraperInputDto = {
        siteType: [Site.AIRBNB],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirbnbService();
      const result = await service.scrape({
        siteType: [Site.AIRBNB],
        searchTerm: 'TRUST',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('airbnb-7501234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirbnbService();
      const result = await service.scrape({
        siteType: [Site.AIRBNB],
        searchTerm: 'design',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('airbnb-7502345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AirbnbService();
      const result = await service.scrape({
        siteType: [Site.AIRBNB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AirbnbService();
      const result = await service.scrape({
        siteType: [Site.AIRBNB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
