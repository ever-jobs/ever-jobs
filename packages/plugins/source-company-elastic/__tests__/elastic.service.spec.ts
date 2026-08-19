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

import { ElasticModule, ElasticService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'elastic-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 060 / T04 — `ElasticService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ElasticService` through `ElasticModule`.
 *   2. `Site.ELASTIC === 'elastic'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `elastic` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-11 vanity-domain
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `jobs.elastic.co/jobs?gh_jid=<id>&gh_jid=<id>` shape — custom
 *      vanity domain with the duplicate `gh_jid` query parameter),
 *      (d) `companyName === 'Elastic'` (wire-passthrough byte-for-byte;
 *      D-09 omitted), (e) D-10 wire-title `.trim()` regression — the
 *      first fixture title `'Account Executive '` carries trailing pad
 *      bytes pre-emit AND emitted `title === 'Account Executive'`
 *      (pad-free), (f) the emitted `department` for the first listing
 *      matches the wire `departments[0].name` byte-for-byte (compound
 *      `'Sales - EMEA - UKI'` form preserved through emit) — D-11
 *      compound-form pass-through guard.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive),
 *      including a search against the trimmed title.
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — the lowercase `'sales'` substring matches the first listing's
 *      `'Sales - EMEA - UKI'` compound-form department).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ElasticService — Spec 060 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ElasticModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ElasticModule],
      }).compile();
      const service = moduleRef.get(ElasticService);
      expect(service).toBeInstanceOf(ElasticService);
      await moduleRef.close();
    });

    it('exports the Site.ELASTIC = "elastic" enum value', () => {
      expect(Site.ELASTIC).toBe('elastic');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ElasticService();
      const input: ScraperInputDto = {
        siteType: [Site.ELASTIC],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const acc = dto.jobs.find((j) => j.id === 'elastic-7505982');
      expect(acc).toBeDefined();
      expect(acc?.site).toBe(Site.ELASTIC);
      // D-09 omitted regression guard: wire `company_name` is `'Elastic'`
      // byte-for-byte and the plugin reads it directly.
      expect(acc?.companyName).toBe('Elastic');
      expect(acc?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 regression guard: wire title `'Account Executive '` carries
      // trailing pad bytes; emitted title is the trimmed form.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive ');
      expect(JOBS_PAGE_RAW.jobs[0].title).not.toBe(
        JOBS_PAGE_RAW.jobs[0].title.trim(),
      );
      expect(acc?.title).toBe('Account Executive');
      expect(acc?.title).toBe(JOBS_PAGE_RAW.jobs[0].title.trim());
      expect(acc?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      // Wire shape: Elastic's tenant publishes `absolute_url` on the
      // vanity-domain shape `jobs.elastic.co/jobs?gh_jid=<id>&gh_jid=<id>`
      // — variant 11 (the **first** plugin in the cohort to use this
      // shape) (Spec 060 § 10 D-04).
      expect(acc?.jobUrl).toBe(
        'https://jobs.elastic.co/jobs?gh_jid=7505982&gh_jid=7505982',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `jobs.elastic.co` substring (vanity-domain host) AND the literal
      // `gh_jid=` substring (the wire query suffix variant 11 carries
      // duplicated) AND must NOT contain the literal `boards.greenhouse.io`
      // substring (locking the variant-11 vanity-domain shape against
      // future refactors that might naively normalise to a
      // variant-1 / variant-2 / variant-10 Greenhouse-host template).
      expect(acc?.jobUrl).toContain('jobs.elastic.co');
      expect(acc?.jobUrl).toContain('gh_jid=');
      expect(acc?.jobUrl).not.toContain('boards.greenhouse.io');
      // D-04 duplicate-query-param lock: `?gh_jid=<id>&gh_jid=<id>`
      // shape with the same listing id repeated literally on the wire.
      expect(acc?.jobUrl).toContain('gh_jid=7505982&gh_jid=7505982');
      expect(acc?.location?.city).toBe('United Kingdom');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the compound `' - '`-separated string
      // `'Sales - EMEA - UKI'` byte-for-byte AND matches the wire
      // `departments[0].name` byte-for-byte (Elastic uses compound
      // department names that scope region within line-of-business).
      expect(acc?.department).toBe('Sales - EMEA - UKI');
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
      expect(acc?.description).not.toContain('<div>');
      expect(acc?.description).not.toContain('<strong>');
      // Sanity: the role-specific body content survives the strip.
      expect(acc?.description).toContain('Elastic');
      expect(acc?.description).toContain('Account Executive');
      expect(acc?.description).toContain('United Kingdom');

      const eng = dto.jobs.find((j) => j.id === 'elastic-7668021');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer - Search Platform');
      expect(eng?.companyName).toBe('Elastic');
      expect(eng?.location?.city).toBe('Remote, United States');
      expect(eng?.isRemote).toBe(true);
      // D-11 second-instance regression guard: the second fixture
      // listing's flat single-token department `'Engineering'` flows
      // through the wire byte-for-byte.
      expect(eng?.department).toBe('Engineering');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Tags stripped after decode.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).toContain('Search Platform Engineering');
      expect(eng?.description).toContain('Senior Software Engineer');

      // Regression guard: the slug must be `elastic` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/elastic/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ElasticService();
      const input: ScraperInputDto = {
        siteType: [Site.ELASTIC],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (D-10 trim-then-match guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ElasticService();
      // The first fixture title is `'Account Executive '` (with trailing
      // pad byte). The plugin trims before the searchTerm match, so
      // a term that includes the pad-byte prefix-bound `'EXECUTIVE'`
      // still matches against the trimmed `'Account Executive'`.
      const result = await service.scrape({
        siteType: [Site.ELASTIC],
        searchTerm: 'EXECUTIVE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('elastic-7505982');
      expect(result.jobs[0].title).toBe('Account Executive');
    });

    it('filters by case-insensitive substring of department name (D-11 compound-form search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ElasticService();
      // The first fixture job has `'Sales - EMEA - UKI'` as its
      // department; the case-insensitive match on the literal
      // `'sales'` substring resolves the first listing.
      const result = await service.scrape({
        siteType: [Site.ELASTIC],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('elastic-7505982');
      expect(result.jobs[0].department).toBe('Sales - EMEA - UKI');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ElasticService();
      const result = await service.scrape({
        siteType: [Site.ELASTIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ElasticService();
      const result = await service.scrape({
        siteType: [Site.ELASTIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
