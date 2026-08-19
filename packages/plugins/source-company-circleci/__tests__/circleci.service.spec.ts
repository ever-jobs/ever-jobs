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

import { CircleCIModule, CircleCIService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'circleci-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 051 / T04 — `CircleCIService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CircleCIService` through `CircleCIModule`.
 *   2. `Site.CIRCLECI === 'circleci'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `circleci` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), (c) the
 *      variant-7 wire-shape
 *      `http://www.circleci.com/careers/jobs/<id>/?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04), (d) the
 *      emitted `jobUrl` starts with `http://` (HTTP scheme lock —
 *      D-04), and (e) the emitted `companyName` is the brand name
 *      `'CircleCI'` (D-09 — matches the wire `company_name`
 *      byte-for-byte; no legal-entity suffix to clean).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CircleCIService — Spec 051 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CircleCIModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CircleCIModule],
      }).compile();
      const service = moduleRef.get(CircleCIService);
      expect(service).toBeInstanceOf(CircleCIService);
      await moduleRef.close();
    });

    it('exports the Site.CIRCLECI = "circleci" enum value', () => {
      expect(Site.CIRCLECI).toBe('circleci');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CircleCIService();
      const input: ScraperInputDto = {
        siteType: [Site.CIRCLECI],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ai = dto.jobs.find((j) => j.id === 'circleci-8481915002');
      expect(ai).toBeDefined();
      expect(ai?.site).toBe(Site.CIRCLECI);
      // D-09 regression guard: the wire `company_name` is the bare
      // brand name `'CircleCI'` (no legal-entity suffix); the emitted
      // `companyName` matches the wire byte-for-byte AND is the
      // string-literal pin in the mapping.
      expect(ai?.companyName).toBe('CircleCI');
      expect(ai?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ai?.title).toBe('AI Community Engineer');
      // Wire shape: CircleCI's tenant publishes `absolute_url` on the
      // apex-www marketing-site, HTTP scheme, with a
      // `/careers/jobs/<id>/` path-with-trailing-slash before the query
      // string — the **seventh** distinct wire-shape variant in the
      // cohort and the first plugin to publish on the HTTP scheme
      // (Spec 051 § 10 D-04).
      expect(ai?.jobUrl).toBe(
        'http://www.circleci.com/careers/jobs/8481915002/?gh_jid=8481915002',
      );
      // D-04 regression guard: the emitted `jobUrl` MUST start with
      // `http://` (locking the HTTP scheme against future refactors
      // that might naively HTTPS-upgrade the wire URL).
      expect(ai?.jobUrl?.startsWith('http://')).toBe(true);
      expect(ai?.jobUrl?.startsWith('https://')).toBe(false);
      // D-04 regression guard: trailing slash before query is preserved.
      expect(ai?.jobUrl).toContain('/8481915002/?gh_jid=');
      expect(ai?.location?.city).toBe('San Francisco, CA');
      expect(ai?.department).toBe('Engineering');
      expect(ai?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>`/`<h3>` (tags not stripped after decode).
      expect(ai?.description).not.toContain('&lt;');
      expect(ai?.description).not.toContain('&quot;');
      expect(ai?.description).not.toContain('<p>');
      expect(ai?.description).not.toContain('<h3');
      expect(ai?.description).toContain('About the Role');
      // Numeric entity (`&amp;#39;` → `&#39;` → `'`) decoded to ASCII
      // apostrophe.
      expect(ai?.description).toContain("can't stop");
      // Named entity (`&amp;rsquo;` → `&rsquo;` → `'` U+2019) decoded
      // to a real right-single-quote.
      expect(ai?.description).toContain('We’re looking');

      const eng = dto.jobs.find((j) => j.id === 'circleci-8475304002');
      expect(eng?.isRemote).toBe(true);
      expect(eng?.department).toBe('Sales');
      expect(eng?.location?.city).toBe('Toronto, Ontario, Remote');
      expect(eng?.companyName).toBe('CircleCI');
      expect(eng?.title).toBe('Senior Software Engineer');
      expect(eng?.jobUrl).toBe(
        'http://www.circleci.com/careers/jobs/8475304002/?gh_jid=8475304002',
      );
      // Named entity (`&amp;rsquo;` → `&rsquo;` → `'` U+2019) decoded
      // in the second listing too.
      expect(eng?.description).toContain('CircleCI’s mission');
      // mdash (`&amp;mdash;` → `&mdash;` → `—`) decoded.
      expect(eng?.description).toContain('—');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');

      // Regression guard: the slug must be `circleci` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/circleci/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CircleCIService();
      const input: ScraperInputDto = {
        siteType: [Site.CIRCLECI],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CircleCIService();
      const result = await service.scrape({
        siteType: [Site.CIRCLECI],
        searchTerm: 'SENIOR',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('circleci-8475304002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CircleCIService();
      const result = await service.scrape({
        siteType: [Site.CIRCLECI],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('circleci-8481915002');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CircleCIService();
      const result = await service.scrape({
        siteType: [Site.CIRCLECI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CircleCIService();
      const result = await service.scrape({
        siteType: [Site.CIRCLECI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
