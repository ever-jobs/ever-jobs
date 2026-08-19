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

import { PostmanModule, PostmanService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'postman-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 054 / T04 — `PostmanService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `PostmanService` through `PostmanModule`.
 *   2. `Site.POSTMAN === 'postman'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `postman` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the `job-boards.greenhouse.io` permalink-
 *      subdomain `absolute_url` flows through byte-for-byte (D-04 —
 *      variant 2 US-region permalink subdomain), (d) the emitted
 *      `companyName` is the brand name `'Postman'` (D-09 — matches
 *      the wire `company_name` byte-for-byte; no legal-entity suffix
 *      to clean), and (e) the cleaned description contains substrings
 *      from BOTH the content-intro section (`'world's leading API
 *      platform'`) AND the role-specific body (`'Account Development
 *      Representative'`/`'pipeline'`) so the decode-then-strip-pass-
 *      through is a complete-document operation (D-11).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('PostmanService — Spec 054 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through PostmanModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PostmanModule],
      }).compile();
      const service = moduleRef.get(PostmanService);
      expect(service).toBeInstanceOf(PostmanService);
      await moduleRef.close();
    });

    it('exports the Site.POSTMAN = "postman" enum value', () => {
      expect(Site.POSTMAN).toBe('postman');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostmanService();
      const input: ScraperInputDto = {
        siteType: [Site.POSTMAN],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const adr = dto.jobs.find((j) => j.id === 'postman-6340592003');
      expect(adr).toBeDefined();
      expect(adr?.site).toBe(Site.POSTMAN);
      // D-09 regression guard: the wire `company_name` is the bare
      // brand name `'Postman'` (no legal-entity suffix); the emitted
      // `companyName` matches the wire byte-for-byte AND is the
      // string-literal pin in the mapping.
      expect(adr?.companyName).toBe('Postman');
      expect(adr?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(adr?.title).toBe('Account Development Representative');
      // Wire shape: Postman's tenant publishes `absolute_url` on the
      // new `job-boards.greenhouse.io` permalink subdomain — the same
      // wire-shape variant Vercel, Affirm, Gusto, Mercury, Buildkite,
      // and Netlify use (Spec 054 § 10 D-04 — variant 2, US-region
      // permalink subdomain).
      expect(adr?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/postman/jobs/6340592003',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) — not the EU-region `job-boards.eu.greenhouse.io`
      // form Ramp Network introduced in Spec 052.
      expect(adr?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(adr?.jobUrl).not.toContain('job-boards.eu.greenhouse.io');
      expect(adr?.location?.city).toBe('San Francisco, California, United States');
      expect(adr?.department).toBe('Sales');
      expect(adr?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<strong>`/`<div>` (tags not stripped
      // after decode).
      expect(adr?.description).not.toContain('&lt;');
      expect(adr?.description).not.toContain('&quot;');
      expect(adr?.description).not.toContain('&#39;');
      expect(adr?.description).not.toContain('<p>');
      expect(adr?.description).not.toContain('<strong>');
      expect(adr?.description).not.toContain('<div>');
      // D-11 regression guard: content-intro section pass-through —
      // the cleaned description contains substrings from BOTH the
      // content-intro recruiter blurb AND the role-specific body.
      expect(adr?.description).toContain('Who Are We?');
      expect(adr?.description).toContain("world's leading API platform");
      expect(adr?.description).toContain('The Opportunity');
      expect(adr?.description).toContain('Account Development Representative');
      expect(adr?.description).toContain('pipeline for the sales organization');

      const danish = dto.jobs.find((j) => j.id === 'postman-7491395003');
      expect(danish).toBeDefined();
      expect(danish?.title).toBe('Account Development Representative (Danish Speaking)');
      expect(danish?.companyName).toBe('Postman');
      expect(danish?.location?.city).toBe('London, UK; Remote, UK');
      // The fixture location string contains "Remote" so isRemote
      // should be true.
      expect(danish?.isRemote).toBe(true);
      expect(danish?.department).toBe('Sales');
      // Tags stripped after decode (no literal `<p>`/`<div>` substrings).
      expect(danish?.description).not.toContain('<p>');
      expect(danish?.description).not.toContain('<div>');
      expect(danish?.description).toContain('Danish-speaking');
      expect(danish?.description).toContain('Nordic region');

      // Regression guard: the slug must be `postman` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/postman/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostmanService();
      const input: ScraperInputDto = {
        siteType: [Site.POSTMAN],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostmanService();
      const result = await service.scrape({
        siteType: [Site.POSTMAN],
        searchTerm: 'DANISH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('postman-7491395003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostmanService();
      const result = await service.scrape({
        siteType: [Site.POSTMAN],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Both fixture jobs are in the `Sales` department, so the
      // case-insensitive match returns both.
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs.every((j) => j.department === 'Sales')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new PostmanService();
      const result = await service.scrape({
        siteType: [Site.POSTMAN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new PostmanService();
      const result = await service.scrape({
        siteType: [Site.POSTMAN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
