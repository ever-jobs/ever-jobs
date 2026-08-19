import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { FairmarkitModule, FairmarkitService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'fairmarkit-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 146 / T04 — `FairmarkitService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FairmarkitService` through `FairmarkitModule`.
 *   2. `Site.FAIRMARKIT === 'fairmarkit'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Fairmarkit'` lock; **D-10 trailing-pad
 *      title-trim lock incl. first-cohort mojibake-Cyrillic-
 *      Es leading-residue observation** (`'Ð¡ore
 *      Software Architect '` → `'Ð¡ore Software
 *      Architect'` — `.trim()` strips trailing ASCII space,
 *      leading mojibake bytes preserved); D-11 trailing-pad
 *      dept-trim lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('FairmarkitService — Spec 146 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FairmarkitModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FairmarkitModule],
      }).compile();
      const service = moduleRef.get(FairmarkitService);
      expect(service).toBeInstanceOf(FairmarkitService);
      await moduleRef.close();
    });

    it('exports the Site.FAIRMARKIT = "fairmarkit" enum value', () => {
      expect(Site.FAIRMARKIT).toBe('fairmarkit');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ga = dto.jobs.find((j) => j.id === 'fairmarkit-5835663004');
      expect(ga).toBeDefined();
      expect(ga?.site).toBe(Site.FAIRMARKIT);
      // D-09 case-symmetric lock.
      expect(ga?.companyName).toBe('Fairmarkit');
      expect(ga?.companyName?.toLowerCase()).toBe('fairmarkit');
      expect(ga?.title).toBe('Growth Account Director (UK, Ireland, Netherlands)');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ga?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/fairmarkit/jobs/5835663004',
      );
      // D-11 clean dept (this listing has clean wire dept).
      expect(ga?.department).toBe('Sales');
      expect(ga?.location?.city).toBe('London, UK');
      expect(ga?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ga?.description).not.toContain('&lt;');
      expect(ga?.description).not.toContain('&amp;');
      expect(ga?.description).not.toContain('<p>');
      expect(ga?.description).toContain('Fairmarkit');

      const cs = dto.jobs.find((j) => j.id === 'fairmarkit-5802084004');
      expect(cs).toBeDefined();
      // D-10 lock — wire title carries leading mojibake-
      // Cyrillic-Es residue (Ð¡ byte sequence) AND
      // trailing ASCII space pad. `.trim()` strips trailing
      // space; leading mojibake bytes preserved by-design
      // (not whitespace).
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Ð¡ore Software Architect ',
      );
      expect(cs?.title).toBe('Ð¡ore Software Architect');
      expect(cs?.title).not.toMatch(/ $/);
      // The leading mojibake pair is preserved by-design.
      expect(cs?.title?.charCodeAt(0)).toBe(0x00d0);
      expect(cs?.title?.charCodeAt(1)).toBe(0x00a1);
      // D-11 lock — wire dept carries trailing-pad
      // (`'International Operations '`); emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe(
        'International Operations ',
      );
      expect(cs?.department).toBe('International Operations');
      expect(cs?.department).not.toMatch(/ $/);
      expect(cs?.companyName).toBe('Fairmarkit');
      expect(cs?.location?.city).toBe('Remote, US');
      expect(cs?.isRemote).toBe(true);
      expect(cs?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/fairmarkit/jobs/5802084004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/fairmarkit/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
        searchTerm: 'GROWTH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fairmarkit-5835663004');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
        searchTerm: 'international operations',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fairmarkit-5802084004');
      expect(result.jobs[0].department).toBe('International Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FairmarkitService();
      const result = await service.scrape({
        siteType: [Site.FAIRMARKIT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
