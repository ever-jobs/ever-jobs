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

import { ZoomInfoModule, ZoomInfoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'zoominfo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 057 / T04 — `ZoomInfoService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ZoomInfoService` through `ZoomInfoModule`.
 *   2. `Site.ZOOMINFO === 'zoominfo'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `zoominfo` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-9 apex-www brand-domain
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `www.zoominfo.com/careers?gh_jid=<id>` shape), (d) the emitted
 *      `companyName` is the brand name `'ZoomInfo'` byte-for-byte AND
 *      does NOT match the wire `company_name` `'ZoomInfo Technologies
 *      LLC'` (D-09 brand-name trim guard), (e) the wire `company_name`
 *      is the literal `'ZoomInfo Technologies LLC'` (regression guard
 *      against the upstream tenant changing its registered legal-
 *      entity name), (f) the emitted `title` has no leading or
 *      trailing whitespace AND for the padded-fixture-listing case the
 *      emitted `title !== fixture.title` (D-10 wire-title trim
 *      observability), and (g) the emitted `department` for the first
 *      listing is the literal numeric-code-prefixed string `'801
 *      Client Services - Support'` byte-for-byte (D-11 first-instance
 *      pass-through guard).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive) — even
 *      after the D-10 wire-title trim observably fires.
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'support'` substring matching the leaf
 *      segment of the hyphen-separated path in the first listing's
 *      numeric-code-prefixed department).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ZoomInfoService — Spec 057 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ZoomInfoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ZoomInfoModule],
      }).compile();
      const service = moduleRef.get(ZoomInfoService);
      expect(service).toBeInstanceOf(ZoomInfoService);
      await moduleRef.close();
    });

    it('exports the Site.ZOOMINFO = "zoominfo" enum value', () => {
      expect(Site.ZOOMINFO).toBe('zoominfo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ZoomInfoService();
      const input: ScraperInputDto = {
        siteType: [Site.ZOOMINFO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'zoominfo-7961383002');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.ZOOMINFO);
      // D-09 regression guard: the wire `company_name` is the legal-
      // entity `'ZoomInfo Technologies LLC'`; the emitted `companyName`
      // is the brand-name trim `'ZoomInfo'` (string literal in the
      // mapping) — locking the trim against a future refactor that
      // would naively read `listing.company_name`.
      expect(ae?.companyName).toBe('ZoomInfo');
      expect(ae?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-09 wire-shape regression guard: the wire `company_name` is
      // the literal `'ZoomInfo Technologies LLC'` (against the upstream
      // tenant renaming its registered legal-entity name).
      expect(JOBS_PAGE_RAW.jobs[0].company_name).toBe('ZoomInfo Technologies LLC');
      expect(ae?.title).toBe('Account Manager, Enterprise Core');
      // D-10 lock: the first fixture title is already trimmed so the
      // `.trim()` is idempotent here, but the test still asserts the
      // emitted `title` has no leading or trailing whitespace.
      expect(ae?.title).toBe(ae?.title?.trim());
      // Wire shape: ZoomInfo's tenant publishes `absolute_url` on the
      // apex-www brand-domain marketing-site shape
      // `www.zoominfo.com/careers?gh_jid=<id>` — variant 9 (the first
      // plugin in the cohort to use this shape) (Spec 057 § 10 D-04).
      expect(ae?.jobUrl).toBe(
        'https://www.zoominfo.com/careers?gh_jid=7961383002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `www.zoominfo.com` substring (apex-www brand-domain) AND the
      // literal `?gh_jid=` substring (the query-param-only listing
      // identification) AND must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-9 shape against future refactors that
      // might naively normalise to a permalink-subdomain template).
      expect(ae?.jobUrl).toContain('www.zoominfo.com');
      expect(ae?.jobUrl).toContain('?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ae?.location?.city).toBe('Remote');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the numeric-code-prefixed string
      // `'801 Client Services - Support'` byte-for-byte AND matches
      // the wire `departments[0].name` byte-for-byte (ZoomInfo is the
      // first plugin in the cohort to ship a fixture with numeric-
      // code-prefixed department names).
      expect(ae?.department).toBe('801 Client Services - Support');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&quot;');
      expect(ae?.description).not.toContain('&#39;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<div>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(ae?.description).toContain('ZoomInfo');
      expect(ae?.description).toContain('Account Manager');
      expect(ae?.description).toContain('Enterprise Core');

      const growth = dto.jobs.find((j) => j.id === 'zoominfo-8500883002');
      expect(growth).toBeDefined();
      // D-10 first-instance regression guard: the wire fixture title
      // `'Account Manager, Enterprise Growth '` (with trailing ASCII
      // space) is observably trimmed to `'Account Manager, Enterprise
      // Growth'` (no trailing space). Asserting both halves: the
      // emitted title is the trimmed form AND the trim observably
      // fired (emitted !== fixture).
      expect(growth?.title).toBe('Account Manager, Enterprise Growth');
      expect(growth?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(growth?.companyName).toBe('ZoomInfo');
      expect(growth?.location?.city).toBe(
        'Bethesda, Maryland, United States; Vancouver, Washington, United States; Waltham, Massachusetts, United States',
      );
      // The fixture location string does NOT contain "Remote" (multi-
      // office HQ string, no remote keyword) so isRemote should be
      // false.
      expect(growth?.isRemote).toBe(false);
      // Different leaf, same numeric-code-prefix family, exercising
      // the prefix diversity (D-11 second-instance pass-through guard).
      expect(growth?.department).toBe('820 R&G - Account Managers');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(growth?.description).not.toContain('<p>');
      expect(growth?.description).toContain('Enterprise Growth');
      expect(growth?.description).toContain('Mid-Market');

      // Regression guard: the slug must be `zoominfo` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/zoominfo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ZoomInfoService();
      const input: ScraperInputDto = {
        siteType: [Site.ZOOMINFO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (post-trim)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ZoomInfoService();
      // 'GROWTH' (uppercase) tests both case-insensitivity AND the
      // post-trim search — the wire fixture title for the second
      // listing has a trailing space pad that the .trim() in the
      // service strips before the searchTerm filter runs, so this
      // filter must match the trimmed title's trailing-edge token
      // `'Growth'` rather than the wire `'Growth '` form.
      const result = await service.scrape({
        siteType: [Site.ZOOMINFO],
        searchTerm: 'GROWTH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('zoominfo-8500883002');
      expect(result.jobs[0].title).toBe('Account Manager, Enterprise Growth');
    });

    it('filters by case-insensitive substring of department name (D-11 numeric-code-prefix-search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ZoomInfoService();
      const result = await service.scrape({
        siteType: [Site.ZOOMINFO],
        searchTerm: 'support',
      } as ScraperInputDto);

      // Only the first fixture job has `'Support'` as the leaf
      // segment of the hyphen-separated path in its numeric-code-
      // prefixed department; the case-insensitive match on the literal
      // `'support'` substring matches the literal `'Support'` leaf
      // segment in the first listing's department.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('zoominfo-7961383002');
      expect(result.jobs[0].department).toBe('801 Client Services - Support');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ZoomInfoService();
      const result = await service.scrape({
        siteType: [Site.ZOOMINFO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ZoomInfoService();
      const result = await service.scrape({
        siteType: [Site.ZOOMINFO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
