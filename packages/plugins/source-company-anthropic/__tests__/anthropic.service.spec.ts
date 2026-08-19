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

import { AnthropicModule, AnthropicService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'anthropic-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 020 / T04 — `AnthropicService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AnthropicService` through `AnthropicModule`.
 *   2. `Site.ANTHROPIC === 'anthropic'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings (matches 'inference' → 1 row).
 *   6. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   7. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('AnthropicService — Spec 020 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AnthropicModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AnthropicModule],
      }).compile();
      const service = moduleRef.get(AnthropicService);
      expect(service).toBeInstanceOf(AnthropicService);
      await moduleRef.close();
    });

    it('exports the Site.ANTHROPIC = "anthropic" enum value', () => {
      expect(Site.ANTHROPIC).toBe('anthropic');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AnthropicService();
      const input: ScraperInputDto = {
        siteType: [Site.ANTHROPIC],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const research = dto.jobs.find((j) => j.id === 'anthropic-5001234');
      expect(research).toBeDefined();
      expect(research?.site).toBe(Site.ANTHROPIC);
      expect(research?.companyName).toBe('Anthropic');
      expect(research?.title).toBe('Member of Technical Staff, Alignment Science');
      expect(research?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/anthropic/jobs/5001234',
      );
      expect(research?.location?.city).toBe('San Francisco, CA');
      expect(research?.department).toBe('Research');
      expect(research?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(research?.description).not.toContain('<p>');
      expect(research?.description).toContain('alignment');

      const inference = dto.jobs.find((j) => j.id === 'anthropic-5002345');
      expect(inference?.isRemote).toBe(true);
      expect(inference?.department).toBe('Engineering');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/anthropic/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AnthropicService();
      const input: ScraperInputDto = {
        siteType: [Site.ANTHROPIC],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AnthropicService();
      const result = await service.scrape({
        siteType: [Site.ANTHROPIC],
        searchTerm: 'INFERENCE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('anthropic-5002345');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AnthropicService();
      const result = await service.scrape({
        siteType: [Site.ANTHROPIC],
        searchTerm: 'research',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('anthropic-5001234');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AnthropicService();
      const result = await service.scrape({
        siteType: [Site.ANTHROPIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AnthropicService();
      const result = await service.scrape({
        siteType: [Site.ANTHROPIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
