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

import { GustoModule, GustoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'gusto-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 048 / T04 — `GustoService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `GustoService` through `GustoModule`.
 *   2. `Site.GUSTO === 'gusto'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `gusto` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), (c) the
 *      new `job-boards.greenhouse.io` permalink-subdomain
 *      `absolute_url` flows through byte-for-byte (D-04), and (d)
 *      the emitted `companyName` is the cleaned brand name `'Gusto'`
 *      rather than the wire `company_name` `'Gusto, Inc.'` (D-09).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('GustoService — Spec 048 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through GustoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GustoModule],
      }).compile();
      const service = moduleRef.get(GustoService);
      expect(service).toBeInstanceOf(GustoService);
      await moduleRef.close();
    });

    it('exports the Site.GUSTO = "gusto" enum value', () => {
      expect(Site.GUSTO).toBe('gusto');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GustoService();
      const input: ScraperInputDto = {
        siteType: [Site.GUSTO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const compliance = dto.jobs.find((j) => j.id === 'gusto-7714510');
      expect(compliance).toBeDefined();
      expect(compliance?.site).toBe(Site.GUSTO);
      // D-09 regression guard: the wire `company_name` is `'Gusto, Inc.'`
      // (legal entity); the emitted `companyName` must be the cleaned
      // brand name `'Gusto'` (string-literal pin in the mapping).
      expect(compliance?.companyName).toBe('Gusto');
      expect(compliance?.companyName).not.toBe('Gusto, Inc.');
      expect(compliance?.title).toBe('AI Manager, Compliance Systems');
      // Wire shape: Gusto's tenant publishes `absolute_url` on the new
      // `job-boards.greenhouse.io` permalink subdomain — the same
      // wire-shape variant Vercel and Affirm use (Spec 048 § 10 D-04).
      expect(compliance?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/gusto/jobs/7714510',
      );
      expect(compliance?.location?.city).toBe('Denver, CO;San Francisco, CA');
      expect(compliance?.department).toBe('Legal & Compliance');
      expect(compliance?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>` (tags not stripped after decode).
      expect(compliance?.description).not.toContain('&lt;');
      expect(compliance?.description).not.toContain('<p>');
      expect(compliance?.description).toContain('mission to grow the small business economy');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(compliance?.description).toContain("we're");
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(compliance?.description).toContain('Gusto’s');

      const eng = dto.jobs.find((j) => j.id === 'gusto-7714511');
      expect(eng?.isRemote).toBe(true);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('Remote, US');
      expect(eng?.companyName).toBe('Gusto');
      // Named entity (&rsquo;) decoded in the second listing too.
      expect(eng?.description).toContain('Gusto’s');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');

      // Regression guard: the slug must be `gusto` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/gusto/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GustoService();
      const input: ScraperInputDto = {
        siteType: [Site.GUSTO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GustoService();
      const result = await service.scrape({
        siteType: [Site.GUSTO],
        searchTerm: 'EMBEDDED',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gusto-7714511');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GustoService();
      const result = await service.scrape({
        siteType: [Site.GUSTO],
        searchTerm: 'compliance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gusto-7714510');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new GustoService();
      const result = await service.scrape({
        siteType: [Site.GUSTO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new GustoService();
      const result = await service.scrape({
        siteType: [Site.GUSTO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
