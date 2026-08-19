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

import { DatadogModule, DatadogService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'datadog-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 038 / T04 — `DatadogService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DatadogService` through `DatadogModule`.
 *   2. `Site.DATADOG === 'datadog'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `datadog` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DatadogService — Spec 038 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DatadogModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DatadogModule],
      }).compile();
      const service = moduleRef.get(DatadogService);
      expect(service).toBeInstanceOf(DatadogService);
      await moduleRef.close();
    });

    it('exports the Site.DATADOG = "datadog" enum value', () => {
      expect(Site.DATADOG).toBe('datadog');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatadogService();
      const input: ScraperInputDto = {
        siteType: [Site.DATADOG],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const apm = dto.jobs.find((j) => j.id === 'datadog-9701234');
      expect(apm).toBeDefined();
      expect(apm?.site).toBe(Site.DATADOG);
      expect(apm?.companyName).toBe('Datadog');
      expect(apm?.title).toBe('Senior Software Engineer, APM Trace Pipeline');
      expect(apm?.jobUrl).toBe(
        'https://boards.greenhouse.io/datadog/jobs/9701234',
      );
      expect(apm?.location?.city).toBe('New York, NY');
      expect(apm?.department).toBe('Engineering');
      expect(apm?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(apm?.description).not.toContain('<p>');
      expect(apm?.description).toContain('APM trace ingestion pipeline');

      const cs = dto.jobs.find((j) => j.id === 'datadog-9702345');
      expect(cs?.isRemote).toBe(true);
      expect(cs?.department).toBe('Customer Success');

      // Regression guard: the slug must be `datadog` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/datadog/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatadogService();
      const input: ScraperInputDto = {
        siteType: [Site.DATADOG],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatadogService();
      const result = await service.scrape({
        siteType: [Site.DATADOG],
        searchTerm: 'APM TRACE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('datadog-9701234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatadogService();
      const result = await service.scrape({
        siteType: [Site.DATADOG],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('datadog-9702345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DatadogService();
      const result = await service.scrape({
        siteType: [Site.DATADOG],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DatadogService();
      const result = await service.scrape({
        siteType: [Site.DATADOG],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
