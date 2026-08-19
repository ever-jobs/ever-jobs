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

import { CoinbaseModule, CoinbaseService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'coinbase-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 023 / T04 — `CoinbaseService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CoinbaseService` through `CoinbaseModule`.
 *   2. `Site.COINBASE === 'coinbase'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CoinbaseService — Spec 023 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CoinbaseModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CoinbaseModule],
      }).compile();
      const service = moduleRef.get(CoinbaseService);
      expect(service).toBeInstanceOf(CoinbaseService);
      await moduleRef.close();
    });

    it('exports the Site.COINBASE = "coinbase" enum value', () => {
      expect(Site.COINBASE).toBe('coinbase');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoinbaseService();
      const input: ScraperInputDto = {
        siteType: [Site.COINBASE],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const exchange = dto.jobs.find((j) => j.id === 'coinbase-7301234');
      expect(exchange).toBeDefined();
      expect(exchange?.site).toBe(Site.COINBASE);
      expect(exchange?.companyName).toBe('Coinbase');
      expect(exchange?.title).toBe('Senior Software Engineer, Exchange Infrastructure');
      expect(exchange?.jobUrl).toBe(
        'https://boards.greenhouse.io/coinbase/jobs/7301234',
      );
      expect(exchange?.location?.city).toBe('San Francisco, CA');
      expect(exchange?.department).toBe('Engineering');
      expect(exchange?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(exchange?.description).not.toContain('<p>');
      expect(exchange?.description).toContain('matching engine');

      const compliance = dto.jobs.find((j) => j.id === 'coinbase-7302345');
      expect(compliance?.isRemote).toBe(true);
      expect(compliance?.department).toBe('Compliance');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/coinbase/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoinbaseService();
      const input: ScraperInputDto = {
        siteType: [Site.COINBASE],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoinbaseService();
      const result = await service.scrape({
        siteType: [Site.COINBASE],
        searchTerm: 'EXCHANGE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coinbase-7301234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoinbaseService();
      const result = await service.scrape({
        siteType: [Site.COINBASE],
        searchTerm: 'compliance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coinbase-7302345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CoinbaseService();
      const result = await service.scrape({
        siteType: [Site.COINBASE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CoinbaseService();
      const result = await service.scrape({
        siteType: [Site.COINBASE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
