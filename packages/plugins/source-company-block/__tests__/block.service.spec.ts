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

import { BlockModule, BlockService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'block-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 042 / T04 — `BlockService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BlockService` through `BlockModule`.
 *   2. `Site.BLOCK === 'block'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `block` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('BlockService — Spec 042 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BlockModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BlockModule],
      }).compile();
      const service = moduleRef.get(BlockService);
      expect(service).toBeInstanceOf(BlockService);
      await moduleRef.close();
    });

    it('exports the Site.BLOCK = "block" enum value', () => {
      expect(Site.BLOCK).toBe('block');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlockService();
      const input: ScraperInputDto = {
        siteType: [Site.BLOCK],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'block-5199076008');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.BLOCK);
      expect(eng?.companyName).toBe('Block');
      expect(eng?.title).toBe(
        'Senior Software Engineer, Cash App Pay Risk Platform',
      );
      // Wire shape: Greenhouse stores `http://block.xyz/...` for this
      // tenant; the listing's absolute_url is preserved verbatim.
      expect(eng?.jobUrl).toBe(
        'http://block.xyz/careers/jobs/5199076008?gh_jid=5199076008',
      );
      expect(eng?.location?.city).toBe(
        'San Francisco, CA, United States of America',
      );
      expect(eng?.department).toBe('Engineering');
      expect(eng?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('Cash App Pay risk-platform');

      const ts = dto.jobs.find((j) => j.id === 'block-5183780008');
      expect(ts?.isRemote).toBe(true);
      expect(ts?.department).toBe('Trust & Safety');

      // Regression guard: the slug must be `block` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/block/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlockService();
      const input: ScraperInputDto = {
        siteType: [Site.BLOCK],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlockService();
      const result = await service.scrape({
        siteType: [Site.BLOCK],
        searchTerm: 'CASH APP PAY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('block-5199076008');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BlockService();
      const result = await service.scrape({
        siteType: [Site.BLOCK],
        searchTerm: 'trust & safety',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('block-5183780008');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BlockService();
      const result = await service.scrape({
        siteType: [Site.BLOCK],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BlockService();
      const result = await service.scrape({
        siteType: [Site.BLOCK],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
