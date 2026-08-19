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

import { FigmaModule, FigmaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'figma-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 032 / T04 — `FigmaService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FigmaService` through `FigmaModule`.
 *   2. `Site.FIGMA === 'figma'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `figma` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('FigmaService — Spec 032 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FigmaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FigmaModule],
      }).compile();
      const service = moduleRef.get(FigmaService);
      expect(service).toBeInstanceOf(FigmaService);
      await moduleRef.close();
    });

    it('exports the Site.FIGMA = "figma" enum value', () => {
      expect(Site.FIGMA).toBe('figma');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FigmaService();
      const input: ScraperInputDto = {
        siteType: [Site.FIGMA],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const tooling = dto.jobs.find((j) => j.id === 'figma-9101234');
      expect(tooling).toBeDefined();
      expect(tooling?.site).toBe(Site.FIGMA);
      expect(tooling?.companyName).toBe('Figma');
      expect(tooling?.title).toBe('Senior Software Engineer, Design-Tooling Platform');
      expect(tooling?.jobUrl).toBe(
        'https://boards.greenhouse.io/figma/jobs/9101234',
      );
      expect(tooling?.location?.city).toBe('San Francisco, CA');
      expect(tooling?.department).toBe('Engineering');
      expect(tooling?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(tooling?.description).not.toContain('<p>');
      expect(tooling?.description).toContain('design-tooling');

      const advocacy = dto.jobs.find((j) => j.id === 'figma-9102345');
      expect(advocacy?.isRemote).toBe(true);
      expect(advocacy?.department).toBe('Design Advocacy');

      // Regression guard: the slug must be `figma` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/figma/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FigmaService();
      const input: ScraperInputDto = {
        siteType: [Site.FIGMA],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FigmaService();
      const result = await service.scrape({
        siteType: [Site.FIGMA],
        searchTerm: 'DESIGN-TOOLING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('figma-9101234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FigmaService();
      const result = await service.scrape({
        siteType: [Site.FIGMA],
        searchTerm: 'design advocacy',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('figma-9102345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FigmaService();
      const result = await service.scrape({
        siteType: [Site.FIGMA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FigmaService();
      const result = await service.scrape({
        siteType: [Site.FIGMA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
