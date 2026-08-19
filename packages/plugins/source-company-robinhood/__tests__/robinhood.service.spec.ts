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

import { RobinhoodModule, RobinhoodService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'robinhood-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 026 / T04 — `RobinhoodService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `RobinhoodService` through `RobinhoodModule`.
 *   2. `Site.ROBINHOOD === 'robinhood'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      `robinhoodjobs` (not bare `robinhood`) Greenhouse slug — see
 *      Spec 026 § 10 D-05.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('RobinhoodService — Spec 026 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through RobinhoodModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [RobinhoodModule],
      }).compile();
      const service = moduleRef.get(RobinhoodService);
      expect(service).toBeInstanceOf(RobinhoodService);
      await moduleRef.close();
    });

    it('exports the Site.ROBINHOOD = "robinhood" enum value', () => {
      expect(Site.ROBINHOOD).toBe('robinhood');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RobinhoodService();
      const input: ScraperInputDto = {
        siteType: [Site.ROBINHOOD],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const brokerage = dto.jobs.find((j) => j.id === 'robinhood-7601234');
      expect(brokerage).toBeDefined();
      expect(brokerage?.site).toBe(Site.ROBINHOOD);
      expect(brokerage?.companyName).toBe('Robinhood');
      expect(brokerage?.title).toBe('Staff Software Engineer, Brokerage Platform');
      expect(brokerage?.jobUrl).toBe(
        'https://boards.greenhouse.io/robinhoodjobs/jobs/7601234',
      );
      expect(brokerage?.location?.city).toBe('Menlo Park, CA');
      expect(brokerage?.department).toBe('Engineering');
      expect(brokerage?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(brokerage?.description).not.toContain('<p>');
      expect(brokerage?.description).toContain('clearing');

      const compliance = dto.jobs.find((j) => j.id === 'robinhood-7602345');
      expect(compliance?.isRemote).toBe(true);
      expect(compliance?.department).toBe('Compliance');

      // Regression guard for Spec 026 § 10 D-05: the slug must be
      // `robinhoodjobs`, not the bare `robinhood`.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/robinhoodjobs/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RobinhoodService();
      const input: ScraperInputDto = {
        siteType: [Site.ROBINHOOD],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RobinhoodService();
      const result = await service.scrape({
        siteType: [Site.ROBINHOOD],
        searchTerm: 'BROKERAGE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('robinhood-7601234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RobinhoodService();
      const result = await service.scrape({
        siteType: [Site.ROBINHOOD],
        searchTerm: 'compliance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('robinhood-7602345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new RobinhoodService();
      const result = await service.scrape({
        siteType: [Site.ROBINHOOD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new RobinhoodService();
      const result = await service.scrape({
        siteType: [Site.ROBINHOOD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
