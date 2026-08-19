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

import { DatabricksModule, DatabricksService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'databricks-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 021 / T04 — `DatabricksService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DatabricksService` through `DatabricksModule`.
 *   2. `Site.DATABRICKS === 'databricks'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DatabricksService — Spec 021 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DatabricksModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DatabricksModule],
      }).compile();
      const service = moduleRef.get(DatabricksService);
      expect(service).toBeInstanceOf(DatabricksService);
      await moduleRef.close();
    });

    it('exports the Site.DATABRICKS = "databricks" enum value', () => {
      expect(Site.DATABRICKS).toBe('databricks');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatabricksService();
      const input: ScraperInputDto = {
        siteType: [Site.DATABRICKS],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const lakehouse = dto.jobs.find((j) => j.id === 'databricks-6101234');
      expect(lakehouse).toBeDefined();
      expect(lakehouse?.site).toBe(Site.DATABRICKS);
      expect(lakehouse?.companyName).toBe('Databricks');
      expect(lakehouse?.title).toBe('Senior Software Engineer, Lakehouse');
      expect(lakehouse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/databricks/jobs/6101234',
      );
      expect(lakehouse?.location?.city).toBe('San Francisco, CA');
      expect(lakehouse?.department).toBe('Engineering');
      expect(lakehouse?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(lakehouse?.description).not.toContain('<p>');
      expect(lakehouse?.description).toContain('Lakehouse');

      const research = dto.jobs.find((j) => j.id === 'databricks-6102345');
      expect(research?.isRemote).toBe(true);
      expect(research?.department).toBe('Mosaic AI Research');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/databricks/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatabricksService();
      const input: ScraperInputDto = {
        siteType: [Site.DATABRICKS],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatabricksService();
      const result = await service.scrape({
        siteType: [Site.DATABRICKS],
        searchTerm: 'LAKEHOUSE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('databricks-6101234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatabricksService();
      const result = await service.scrape({
        siteType: [Site.DATABRICKS],
        searchTerm: 'mosaic',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('databricks-6102345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DatabricksService();
      const result = await service.scrape({
        siteType: [Site.DATABRICKS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DatabricksService();
      const result = await service.scrape({
        siteType: [Site.DATABRICKS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
