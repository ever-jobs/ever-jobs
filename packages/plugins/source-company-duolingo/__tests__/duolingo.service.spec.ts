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

import { DuolingoModule, DuolingoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'duolingo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 046 / T04 — `DuolingoService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DuolingoService` through `DuolingoModule`.
 *   2. `Site.DUOLINGO === 'duolingo'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `duolingo` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08 / mirrors Klaviyo
 *      Spec 045), and (c) the marketing-site careers-subdomain
 *      `absolute_url` flows through byte-for-byte (D-04).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DuolingoService — Spec 046 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DuolingoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DuolingoModule],
      }).compile();
      const service = moduleRef.get(DuolingoService);
      expect(service).toBeInstanceOf(DuolingoService);
      await moduleRef.close();
    });

    it('exports the Site.DUOLINGO = "duolingo" enum value', () => {
      expect(Site.DUOLINGO).toBe('duolingo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DuolingoService();
      const input: ScraperInputDto = {
        siteType: [Site.DUOLINGO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'duolingo-8369239002');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.DUOLINGO);
      expect(eng?.companyName).toBe('Duolingo');
      expect(eng?.title).toBe('Senior Software Engineer, Learning Platform');
      // Wire shape: Duolingo proxies `absolute_url` through its own
      // marketing-site careers-subdomain index with the Greenhouse job
      // id BOTH as a path segment AND as a `gh_jid` query parameter
      // (Spec 046 § 10 D-04).
      expect(eng?.jobUrl).toBe(
        'https://careers.duolingo.com/jobs/8369239002?gh_jid=8369239002',
      );
      expect(eng?.location?.city).toBe('Remote - Pittsburgh, PA');
      expect(eng?.department).toBe('Engineering');
      expect(eng?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>` (tags not stripped after decode).
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('learning-platform');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(eng?.description).toContain("Duolingo's");

      const biz = dto.jobs.find((j) => j.id === 'duolingo-8483526002');
      expect(biz?.isRemote).toBe(false);
      expect(biz?.department).toBe('Business Development');
      expect(biz?.location?.city).toBe('São Paulo, Brazil');
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(biz?.description).toContain('Duolingo’s');

      // Regression guard: the slug must be `duolingo` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/duolingo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DuolingoService();
      const input: ScraperInputDto = {
        siteType: [Site.DUOLINGO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DuolingoService();
      const result = await service.scrape({
        siteType: [Site.DUOLINGO],
        searchTerm: 'LEARNING PLATFORM',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('duolingo-8369239002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DuolingoService();
      const result = await service.scrape({
        siteType: [Site.DUOLINGO],
        searchTerm: 'business',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('duolingo-8483526002');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DuolingoService();
      const result = await service.scrape({
        siteType: [Site.DUOLINGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DuolingoService();
      const result = await service.scrape({
        siteType: [Site.DUOLINGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
