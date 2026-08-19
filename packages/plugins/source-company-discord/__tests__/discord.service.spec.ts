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

import { DiscordModule, DiscordService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'discord-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 022 / T04 — `DiscordService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DiscordService` through `DiscordModule`.
 *   2. `Site.DISCORD === 'discord'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DiscordService — Spec 022 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DiscordModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscordModule],
      }).compile();
      const service = moduleRef.get(DiscordService);
      expect(service).toBeInstanceOf(DiscordService);
      await moduleRef.close();
    });

    it('exports the Site.DISCORD = "discord" enum value', () => {
      expect(Site.DISCORD).toBe('discord');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DiscordService();
      const input: ScraperInputDto = {
        siteType: [Site.DISCORD],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const voice = dto.jobs.find((j) => j.id === 'discord-7201234');
      expect(voice).toBeDefined();
      expect(voice?.site).toBe(Site.DISCORD);
      expect(voice?.companyName).toBe('Discord');
      expect(voice?.title).toBe('Senior Software Engineer, Voice Infrastructure');
      expect(voice?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/discord/jobs/7201234',
      );
      expect(voice?.location?.city).toBe('San Francisco, CA');
      expect(voice?.department).toBe('Engineering');
      expect(voice?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(voice?.description).not.toContain('<p>');
      expect(voice?.description).toContain('voice infrastructure');

      const safety = dto.jobs.find((j) => j.id === 'discord-7202345');
      expect(safety?.isRemote).toBe(true);
      expect(safety?.department).toBe('Trust & Safety');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/discord/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DiscordService();
      const input: ScraperInputDto = {
        siteType: [Site.DISCORD],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DiscordService();
      const result = await service.scrape({
        siteType: [Site.DISCORD],
        searchTerm: 'VOICE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('discord-7201234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DiscordService();
      const result = await service.scrape({
        siteType: [Site.DISCORD],
        searchTerm: 'trust',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('discord-7202345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DiscordService();
      const result = await service.scrape({
        siteType: [Site.DISCORD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DiscordService();
      const result = await service.scrape({
        siteType: [Site.DISCORD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
