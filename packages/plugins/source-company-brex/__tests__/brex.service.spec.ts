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

import { BrexModule, BrexService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'brex-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 047 / T04 — `BrexService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BrexService` through `BrexModule`.
 *   2. `Site.BREX === 'brex'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `brex` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), (c) the
 *      apex-www marketing-site `absolute_url` flows through byte-
 *      for-byte (D-04), and (d) the wire-padded title is trimmed
 *      before mapping to `JobPostDto` (D-09).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('BrexService — Spec 047 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BrexModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BrexModule],
      }).compile();
      const service = moduleRef.get(BrexService);
      expect(service).toBeInstanceOf(BrexService);
      await moduleRef.close();
    });

    it('exports the Site.BREX = "brex" enum value', () => {
      expect(Site.BREX).toBe('brex');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrexService();
      const input: ScraperInputDto = {
        siteType: [Site.BREX],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sales = dto.jobs.find((j) => j.id === 'brex-8379353002');
      expect(sales).toBeDefined();
      expect(sales?.site).toBe(Site.BREX);
      expect(sales?.companyName).toBe('Brex');
      // D-09 regression guard: the wire title was padded with surrounding
      // spaces (` Account Executive, E-Commerce `); the emitted title
      // must be the trimmed value.
      expect(sales?.title).toBe('Account Executive, E-Commerce');
      expect(sales?.title).not.toBe(' Account Executive, E-Commerce ');
      // Wire shape: Brex proxies `absolute_url` through its own apex-www
      // marketing-site careers index with the Greenhouse job id BOTH as a
      // path segment AND as a `gh_jid` query parameter (Spec 047 § 10
      // D-04).
      expect(sales?.jobUrl).toBe(
        'https://www.brex.com/careers/8379353002?gh_jid=8379353002',
      );
      expect(sales?.location?.city).toBe('Vancouver, British Columbia, Canada');
      expect(sales?.department).toBe('Sales');
      expect(sales?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>` (tags not stripped after decode).
      expect(sales?.description).not.toContain('&lt;');
      expect(sales?.description).not.toContain('<p>');
      expect(sales?.description).toContain('intelligent finance platform');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(sales?.description).toContain("world's");

      const eng = dto.jobs.find((j) => j.id === 'brex-8379350002');
      expect(eng?.isRemote).toBe(true);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('Remote, US');
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(eng?.description).toContain('Brex’s');

      // Regression guard: the slug must be `brex` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/brex/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrexService();
      const input: ScraperInputDto = {
        siteType: [Site.BREX],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrexService();
      const result = await service.scrape({
        siteType: [Site.BREX],
        searchTerm: 'EMPOWER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('brex-8379350002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrexService();
      const result = await service.scrape({
        siteType: [Site.BREX],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('brex-8379353002');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BrexService();
      const result = await service.scrape({
        siteType: [Site.BREX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BrexService();
      const result = await service.scrape({
        siteType: [Site.BREX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
