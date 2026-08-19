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

import { TwilioModule, TwilioService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'twilio-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 035 / T04 — `TwilioService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `TwilioService` through `TwilioModule`.
 *   2. `Site.TWILIO === 'twilio'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `twilio` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('TwilioService — Spec 035 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through TwilioModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TwilioModule],
      }).compile();
      const service = moduleRef.get(TwilioService);
      expect(service).toBeInstanceOf(TwilioService);
      await moduleRef.close();
    });

    it('exports the Site.TWILIO = "twilio" enum value', () => {
      expect(Site.TWILIO).toBe('twilio');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TwilioService();
      const input: ScraperInputDto = {
        siteType: [Site.TWILIO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const messaging = dto.jobs.find((j) => j.id === 'twilio-9401234');
      expect(messaging).toBeDefined();
      expect(messaging?.site).toBe(Site.TWILIO);
      expect(messaging?.companyName).toBe('Twilio');
      expect(messaging?.title).toBe('Senior Software Engineer, Programmable Messaging');
      expect(messaging?.jobUrl).toBe(
        'https://boards.greenhouse.io/twilio/jobs/9401234',
      );
      expect(messaging?.location?.city).toBe('San Francisco, CA');
      expect(messaging?.department).toBe('Engineering');
      expect(messaging?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(messaging?.description).not.toContain('<p>');
      expect(messaging?.description).toContain('Programmable Messaging');

      const success = dto.jobs.find((j) => j.id === 'twilio-9402345');
      expect(success?.isRemote).toBe(true);
      expect(success?.department).toBe('Customer Success');

      // Regression guard: the slug must be `twilio` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/twilio/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TwilioService();
      const input: ScraperInputDto = {
        siteType: [Site.TWILIO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TwilioService();
      const result = await service.scrape({
        siteType: [Site.TWILIO],
        searchTerm: 'PROGRAMMABLE MESSAGING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('twilio-9401234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TwilioService();
      const result = await service.scrape({
        siteType: [Site.TWILIO],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('twilio-9402345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new TwilioService();
      const result = await service.scrape({
        siteType: [Site.TWILIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new TwilioService();
      const result = await service.scrape({
        siteType: [Site.TWILIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
