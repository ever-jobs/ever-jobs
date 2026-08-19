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

import { MercuryModule, MercuryService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'mercury-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 049 / T04 — `MercuryService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MercuryService` through `MercuryModule`.
 *   2. `Site.MERCURY === 'mercury'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `mercury` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), (c) the
 *      new `job-boards.greenhouse.io` permalink-subdomain
 *      `absolute_url` flows through byte-for-byte (D-04), and (d)
 *      the emitted `companyName` is the brand name `'Mercury'`
 *      (D-09 — matches the wire `company_name` byte-for-byte; no
 *      legal-entity suffix to clean).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('MercuryService — Spec 049 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MercuryModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MercuryModule],
      }).compile();
      const service = moduleRef.get(MercuryService);
      expect(service).toBeInstanceOf(MercuryService);
      await moduleRef.close();
    });

    it('exports the Site.MERCURY = "mercury" enum value', () => {
      expect(Site.MERCURY).toBe('mercury');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MercuryService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCURY],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sales = dto.jobs.find((j) => j.id === 'mercury-5820682004');
      expect(sales).toBeDefined();
      expect(sales?.site).toBe(Site.MERCURY);
      // D-09 regression guard: the wire `company_name` is the bare
      // brand name `'Mercury'` (no legal-entity suffix); the emitted
      // `companyName` matches the wire byte-for-byte AND is the
      // string-literal pin in the mapping.
      expect(sales?.companyName).toBe('Mercury');
      expect(sales?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(sales?.title).toBe('Account Development Manager');
      // Wire shape: Mercury's tenant publishes `absolute_url` on the new
      // `job-boards.greenhouse.io` permalink subdomain — the same
      // wire-shape variant Vercel, Affirm, and Gusto use (Spec 049 § 10
      // D-04).
      expect(sales?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/mercury/jobs/5820682004',
      );
      expect(sales?.location?.city).toBe(
        'San Francisco, CA, New York, NY, Portland, OR, or Remote within United States',
      );
      expect(sales?.department).toBe('Sales and Partnerships');
      // The location contains "Remote" (case-insensitive) so isRemote
      // should be true.
      expect(sales?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>` (tags not stripped after decode).
      expect(sales?.description).not.toContain('&lt;');
      expect(sales?.description).not.toContain('<p>');
      expect(sales?.description).toContain('Railroads');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(sales?.description).toContain("didn't");
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(sales?.description).toContain('Mercury’s');

      const eng = dto.jobs.find((j) => j.id === 'mercury-5820682005');
      expect(eng?.isRemote).toBe(true);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('Remote within United States');
      expect(eng?.companyName).toBe('Mercury');
      // Named entity (&rsquo;) decoded in the second listing too.
      expect(eng?.description).toContain('Mercury’s');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');

      // Regression guard: the slug must be `mercury` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/mercury/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MercuryService();
      const input: ScraperInputDto = {
        siteType: [Site.MERCURY],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MercuryService();
      const result = await service.scrape({
        siteType: [Site.MERCURY],
        searchTerm: 'SOFTWARE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mercury-5820682005');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MercuryService();
      const result = await service.scrape({
        siteType: [Site.MERCURY],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mercury-5820682004');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MercuryService();
      const result = await service.scrape({
        siteType: [Site.MERCURY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MercuryService();
      const result = await service.scrape({
        siteType: [Site.MERCURY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
