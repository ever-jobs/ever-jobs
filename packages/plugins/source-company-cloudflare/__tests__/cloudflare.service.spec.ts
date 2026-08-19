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

import { CloudflareModule, CloudflareService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cloudflare-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 036 / T04 — `CloudflareService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CloudflareService` through `CloudflareModule`.
 *   2. `Site.CLOUDFLARE === 'cloudflare'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `cloudflare` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CloudflareService — Spec 036 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CloudflareModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CloudflareModule],
      }).compile();
      const service = moduleRef.get(CloudflareService);
      expect(service).toBeInstanceOf(CloudflareService);
      await moduleRef.close();
    });

    it('exports the Site.CLOUDFLARE = "cloudflare" enum value', () => {
      expect(Site.CLOUDFLARE).toBe('cloudflare');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CloudflareService();
      const input: ScraperInputDto = {
        siteType: [Site.CLOUDFLARE],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const workers = dto.jobs.find((j) => j.id === 'cloudflare-9501234');
      expect(workers).toBeDefined();
      expect(workers?.site).toBe(Site.CLOUDFLARE);
      expect(workers?.companyName).toBe('Cloudflare');
      expect(workers?.title).toBe('Senior Software Engineer, Workers Runtime');
      expect(workers?.jobUrl).toBe(
        'https://boards.greenhouse.io/cloudflare/jobs/9501234',
      );
      expect(workers?.location?.city).toBe('San Francisco, CA');
      expect(workers?.department).toBe('Engineering');
      expect(workers?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(workers?.description).not.toContain('<p>');
      expect(workers?.description).toContain('Workers V8 isolate');

      const trust = dto.jobs.find((j) => j.id === 'cloudflare-9502345');
      expect(trust?.isRemote).toBe(true);
      expect(trust?.department).toBe('Customer Success');

      // Regression guard: the slug must be `cloudflare` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cloudflare/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CloudflareService();
      const input: ScraperInputDto = {
        siteType: [Site.CLOUDFLARE],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CloudflareService();
      const result = await service.scrape({
        siteType: [Site.CLOUDFLARE],
        searchTerm: 'WORKERS RUNTIME',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cloudflare-9501234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CloudflareService();
      const result = await service.scrape({
        siteType: [Site.CLOUDFLARE],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cloudflare-9502345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CloudflareService();
      const result = await service.scrape({
        siteType: [Site.CLOUDFLARE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CloudflareService();
      const result = await service.scrape({
        siteType: [Site.CLOUDFLARE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
