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

import { RedditModule, RedditService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'reddit-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 027 / T04 — `RedditService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `RedditService` through `RedditModule`.
 *   2. `Site.REDDIT === 'reddit'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `reddit` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('RedditService — Spec 027 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through RedditModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [RedditModule],
      }).compile();
      const service = moduleRef.get(RedditService);
      expect(service).toBeInstanceOf(RedditService);
      await moduleRef.close();
    });

    it('exports the Site.REDDIT = "reddit" enum value', () => {
      expect(Site.REDDIT).toBe('reddit');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RedditService();
      const input: ScraperInputDto = {
        siteType: [Site.REDDIT],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const adsRanking = dto.jobs.find((j) => j.id === 'reddit-7701234');
      expect(adsRanking).toBeDefined();
      expect(adsRanking?.site).toBe(Site.REDDIT);
      expect(adsRanking?.companyName).toBe('Reddit');
      expect(adsRanking?.title).toBe('Staff Software Engineer, Ads Ranking Platform');
      expect(adsRanking?.jobUrl).toBe(
        'https://boards.greenhouse.io/reddit/jobs/7701234',
      );
      expect(adsRanking?.location?.city).toBe('San Francisco, CA');
      expect(adsRanking?.department).toBe('Engineering');
      expect(adsRanking?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(adsRanking?.description).not.toContain('<p>');
      expect(adsRanking?.description).toContain('ad-auctions');

      const trustSafety = dto.jobs.find((j) => j.id === 'reddit-7702345');
      expect(trustSafety?.isRemote).toBe(true);
      expect(trustSafety?.department).toBe('Trust and Safety');

      // Regression guard: the slug must be `reddit` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/reddit/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RedditService();
      const input: ScraperInputDto = {
        siteType: [Site.REDDIT],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RedditService();
      const result = await service.scrape({
        siteType: [Site.REDDIT],
        searchTerm: 'ADS RANKING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('reddit-7701234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RedditService();
      const result = await service.scrape({
        siteType: [Site.REDDIT],
        searchTerm: 'trust and safety',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('reddit-7702345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new RedditService();
      const result = await service.scrape({
        siteType: [Site.REDDIT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new RedditService();
      const result = await service.scrape({
        siteType: [Site.REDDIT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
