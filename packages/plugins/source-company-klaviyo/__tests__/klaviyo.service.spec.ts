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

import { KlaviyoModule, KlaviyoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'klaviyo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 045 / T04 — `KlaviyoService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `KlaviyoService` through `KlaviyoModule`.
 *   2. `Site.KLAVIYO === 'klaviyo'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `klaviyo` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), and (c) the
 *      marketing-site-proxy `absolute_url` flows through byte-for-
 *      byte (D-04).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('KlaviyoService — Spec 045 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through KlaviyoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [KlaviyoModule],
      }).compile();
      const service = moduleRef.get(KlaviyoService);
      expect(service).toBeInstanceOf(KlaviyoService);
      await moduleRef.close();
    });

    it('exports the Site.KLAVIYO = "klaviyo" enum value', () => {
      expect(Site.KLAVIYO).toBe('klaviyo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new KlaviyoService();
      const input: ScraperInputDto = {
        siteType: [Site.KLAVIYO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'klaviyo-7694808003');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.KLAVIYO);
      expect(eng?.companyName).toBe('Klaviyo');
      expect(eng?.title).toBe('Senior Software Engineer, Customer Data Platform');
      // Wire shape: Klaviyo proxies `absolute_url` through its own
      // marketing-site careers index with the Greenhouse job id as a
      // `gh_jid` query parameter (Spec 045 § 10 D-04).
      expect(eng?.jobUrl).toBe(
        'https://www.klaviyo.com/careers/jobs?gh_jid=7694808003',
      );
      expect(eng?.location?.city).toBe('Remote, US');
      expect(eng?.department).toBe('Engineering');
      expect(eng?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>` (tags not stripped after decode).
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('customer-data platform');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(eng?.description).toContain("Klaviyo's");

      const sales = dto.jobs.find((j) => j.id === 'klaviyo-7529251003');
      expect(sales?.isRemote).toBe(false);
      expect(sales?.department).toBe('Sales');
      expect(sales?.location?.city).toBe('New York, NY');
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(sales?.description).toContain('Klaviyo’s');

      // Regression guard: the slug must be `klaviyo` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/klaviyo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new KlaviyoService();
      const input: ScraperInputDto = {
        siteType: [Site.KLAVIYO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new KlaviyoService();
      const result = await service.scrape({
        siteType: [Site.KLAVIYO],
        searchTerm: 'CUSTOMER DATA',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('klaviyo-7694808003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new KlaviyoService();
      const result = await service.scrape({
        siteType: [Site.KLAVIYO],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('klaviyo-7529251003');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new KlaviyoService();
      const result = await service.scrape({
        siteType: [Site.KLAVIYO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new KlaviyoService();
      const result = await service.scrape({
        siteType: [Site.KLAVIYO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
