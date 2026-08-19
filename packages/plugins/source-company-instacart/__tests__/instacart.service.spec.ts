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

import { InstacartModule, InstacartService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'instacart-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 039 / T04 — `InstacartService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `InstacartService` through `InstacartModule`.
 *   2. `Site.INSTACART === 'instacart'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `instacart` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('InstacartService — Spec 039 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through InstacartModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [InstacartModule],
      }).compile();
      const service = moduleRef.get(InstacartService);
      expect(service).toBeInstanceOf(InstacartService);
      await moduleRef.close();
    });

    it('exports the Site.INSTACART = "instacart" enum value', () => {
      expect(Site.INSTACART).toBe('instacart');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstacartService();
      const input: ScraperInputDto = {
        siteType: [Site.INSTACART],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'instacart-7642776');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.INSTACART);
      expect(eng?.companyName).toBe('Instacart');
      expect(eng?.title).toBe(
        'Senior Software Engineer, Marketplace Order Fulfillment',
      );
      expect(eng?.jobUrl).toBe(
        'https://instacart.careers/job/?gh_jid=7642776',
      );
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.department).toBe('Engineering');
      expect(eng?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('order-fulfillment pipeline');

      const ads = dto.jobs.find((j) => j.id === 'instacart-7642801');
      expect(ads?.isRemote).toBe(true);
      expect(ads?.department).toBe('Ad Sales');

      // Regression guard: the slug must be `instacart` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/instacart/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstacartService();
      const input: ScraperInputDto = {
        siteType: [Site.INSTACART],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstacartService();
      const result = await service.scrape({
        siteType: [Site.INSTACART],
        searchTerm: 'ORDER FULFILLMENT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('instacart-7642776');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstacartService();
      const result = await service.scrape({
        siteType: [Site.INSTACART],
        searchTerm: 'ad sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('instacart-7642801');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new InstacartService();
      const result = await service.scrape({
        siteType: [Site.INSTACART],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new InstacartService();
      const result = await service.scrape({
        siteType: [Site.INSTACART],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
