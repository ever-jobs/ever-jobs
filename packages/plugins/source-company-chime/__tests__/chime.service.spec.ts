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

import { ChimeModule, ChimeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'chime-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 059 / T04 — `ChimeService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ChimeService` through `ChimeModule`.
 *   2. `Site.CHIME === 'chime'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `chime` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-10 legacy hosted-board
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `boards.greenhouse.io/chime/jobs/<id>?gh_jid=<id>` shape — bare
 *      apex without `job-` prefix, plus trailing `?gh_jid=<id>` query
 *      suffix), (d) the brand-name trim string-literal pin (D-09 —
 *      wire `'Chime Financial, Inc'` trimmed to emit `'Chime'`), (e)
 *      the emitted `department` for the first listing matches the
 *      wire `departments[0].name` byte-for-byte AND for the second
 *      listing the literal `&` byte in `'AI & App Experience
 *      Engineering'` is preserved through emit (D-11 literal-
 *      ampersand pass-through guard).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — the lowercase `'engineering'` substring matches the second
 *      listing's `'AI & App Experience Engineering'` department).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ChimeService — Spec 059 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ChimeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ChimeModule],
      }).compile();
      const service = moduleRef.get(ChimeService);
      expect(service).toBeInstanceOf(ChimeService);
      await moduleRef.close();
    });

    it('exports the Site.CHIME = "chime" enum value', () => {
      expect(Site.CHIME).toBe('chime');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChimeService();
      const input: ScraperInputDto = {
        siteType: [Site.CHIME],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const acc = dto.jobs.find((j) => j.id === 'chime-8391630002');
      expect(acc).toBeDefined();
      expect(acc?.site).toBe(Site.CHIME);
      // D-09 brand-name trim regression guard: the emitted `companyName`
      // is the brand name `'Chime'` byte-for-byte AND must NOT match
      // the wire `company_name` `'Chime Financial, Inc'` (locking the
      // string-literal pin against future refactors that might naively
      // pass through the wire shape) AND must NOT contain the legal-
      // entity-suffix substrings `', Inc'`, `', Inc.'`, `'Financial'`,
      // or `'LLC'`.
      expect(acc?.companyName).toBe('Chime');
      expect(acc?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(acc?.companyName).not.toContain(', Inc');
      expect(acc?.companyName).not.toContain(', Inc.');
      expect(acc?.companyName).not.toContain('Financial');
      expect(acc?.companyName).not.toContain('LLC');
      expect(acc?.title).toBe('Accountant');
      // Wire shape: Chime's tenant publishes `absolute_url` on the
      // legacy hosted-board apex `boards.greenhouse.io/chime/jobs/<id>
      // ?gh_jid=<id>` — variant 10 (the **first** plugin in the cohort
      // to use this shape) (Spec 059 § 10 D-04).
      expect(acc?.jobUrl).toBe(
        'https://boards.greenhouse.io/chime/jobs/8391630002?gh_jid=8391630002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `boards.greenhouse.io` substring (legacy hosted-board apex)
      // AND the literal `/chime/jobs/` substring (the path-with-`jobs`-
      // segment listing identification) AND the literal `?gh_jid=`
      // substring (the trailing query suffix variant 10 carries) AND
      // must NOT contain the literal `job-boards.greenhouse.io`
      // substring (locking the variant-10 shape against future
      // refactors that might naively normalise to a variant-2 modern
      // permalink template).
      expect(acc?.jobUrl).toContain('boards.greenhouse.io');
      expect(acc?.jobUrl).toContain('/chime/jobs/');
      expect(acc?.jobUrl).toContain('?gh_jid=');
      expect(acc?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(acc?.location?.city).toBe('San Francisco, CA, USA');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the flat single-token string `'Accounting'`
      // byte-for-byte AND matches the wire `departments[0].name`
      // byte-for-byte (Chime uses simple flat single-token department
      // names).
      expect(acc?.department).toBe('Accounting');
      expect(acc?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(acc?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(acc?.description).not.toContain('&lt;');
      expect(acc?.description).not.toContain('&quot;');
      expect(acc?.description).not.toContain('&#39;');
      expect(acc?.description).not.toContain('<p>');
      expect(acc?.description).not.toContain('<h2>');
      expect(acc?.description).not.toContain('<strong>');
      expect(acc?.description).not.toContain('<span>');
      // Sanity: the role-specific body content survives the strip.
      expect(acc?.description).toContain('Chime');
      expect(acc?.description).toContain('Accountant');
      expect(acc?.description).toContain('month-end close');

      const eng = dto.jobs.find((j) => j.id === 'chime-8489550002');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, AI Experience');
      expect(eng?.companyName).toBe('Chime');
      expect(eng?.location?.city).toBe('Chicago, IL, USA');
      expect(eng?.isRemote).toBe(false);
      // D-11 second-instance pass-through guard: the literal `&` byte
      // in `'AI & App Experience Engineering'` flows through to the
      // emit without entity-encoding (no `&amp;`) and without
      // stripping. Also asserts that the wire `&` byte matches the
      // emitted `&` byte byte-for-byte.
      expect(eng?.department).toBe('AI & App Experience Engineering');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(eng?.department).toContain('&');
      expect(eng?.department).not.toContain('&amp;');
      // Tags stripped after decode.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).toContain('AI & App Experience Engineering');
      expect(eng?.description).toContain('Senior Software Engineer');

      // Regression guard: the slug must be `chime` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/chime/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChimeService();
      const input: ScraperInputDto = {
        siteType: [Site.CHIME],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChimeService();
      const result = await service.scrape({
        siteType: [Site.CHIME],
        searchTerm: 'ACCOUNTANT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('chime-8391630002');
      expect(result.jobs[0].title).toBe('Accountant');
    });

    it('filters by case-insensitive substring of department name (D-11 ampersand-bearing search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ChimeService();
      const result = await service.scrape({
        siteType: [Site.CHIME],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // The second fixture job has `'AI & App Experience Engineering'`
      // as its department; the case-insensitive match on the literal
      // `'engineering'` substring matches the trailing-token
      // `'Engineering'` in the second listing's department.
      // The first listing also gets a title-substring match because
      // `'Accountant'` does not contain `'engineering'` and `'Accounting'`
      // does not either, so the first listing is filtered out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('chime-8489550002');
      expect(result.jobs[0].department).toBe('AI & App Experience Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ChimeService();
      const result = await service.scrape({
        siteType: [Site.CHIME],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ChimeService();
      const result = await service.scrape({
        siteType: [Site.CHIME],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
