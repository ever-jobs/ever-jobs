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

import { IntercomModule, IntercomService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'intercom-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 061 / T04 — `IntercomService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `IntercomService` through `IntercomModule`.
 *   2. `Site.INTERCOM === 'intercom'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `intercom` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-2 US-region permalink
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/intercom/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the brand name `'Intercom'` byte-for-
 *      byte AND matches the wire `company_name` byte-for-byte (D-09
 *      omission lock — regression guard against the upstream tenant
 *      adding a future legal-entity suffix), (e) the emitted `title`
 *      has no leading or trailing whitespace AND for the padded-
 *      fixture-listing case the emitted `title !== fixture.title`
 *      (D-10 wire-title trim observability), and (f) the emitted
 *      `department` for the first listing matches the wire
 *      `departments[0].name` byte-for-byte (D-11 first-instance
 *      pass-through guard for the flat single-token department format).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive) — the
 *      filter must work post-trim (D-10 trim-then-match guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'engineering'` substring matching the
 *      flat single-token department in the second listing).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('IntercomService — Spec 061 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through IntercomModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IntercomModule],
      }).compile();
      const service = moduleRef.get(IntercomService);
      expect(service).toBeInstanceOf(IntercomService);
      await moduleRef.close();
    });

    it('exports the Site.INTERCOM = "intercom" enum value', () => {
      expect(Site.INTERCOM).toBe('intercom');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IntercomService();
      const input: ScraperInputDto = {
        siteType: [Site.INTERCOM],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'intercom-7247950');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.INTERCOM);
      // D-09 omission lock: the emitted `companyName` is the brand
      // name `'Intercom'` byte-for-byte AND matches the wire
      // `company_name` byte-for-byte (locking the wire-shape regression
      // guard against the upstream tenant adding a future legal-entity
      // suffix). The plugin reads `listing.company_name` directly.
      expect(ae?.companyName).toBe('Intercom');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 first-instance regression guard: the wire fixture title
      // `'Account Executive, Commercial '` (with trailing ASCII space)
      // is observably trimmed to `'Account Executive, Commercial'` (no
      // trailing space). Asserting both halves: the emitted title is
      // the trimmed form AND the trim observably fired (emitted !==
      // fixture).
      expect(ae?.title).toBe('Account Executive, Commercial');
      expect(ae?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ae?.title).toBe(ae?.title?.trim());
      // Wire shape: Intercom's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // intercom/jobs/<id>` — variant 2 (the tenth plugin in the
      // cohort to use this shape) (Spec 061 § 10 D-04).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/intercom/jobs/7247950',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/intercom/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a variant-10 or
      // variant-11 template).
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(ae?.jobUrl).toContain('/intercom/jobs/');
      expect(ae?.jobUrl).not.toContain('?gh_jid=');
      expect(ae?.location?.city).toBe('London, United Kingdom');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the flat single-token string `'Sales'`
      // byte-for-byte AND matches the wire `departments[0].name`
      // byte-for-byte (Intercom uses simple flat single-token
      // department names like Attentive, distinct from Elastic's
      // compound `' - '`-separated regional-scoped format, ZoomInfo's
      // numeric-code-prefix format, and Toast's colon-separated
      // nested-path format).
      expect(ae?.department).toBe('Sales');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae?.isRemote).toBe(false);
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
      expect(ae?.description).toContain('Intercom');
      expect(ae?.description).toContain('Account Executive, Commercial');
      expect(ae?.description).toContain('Fin');

      const eng = dto.jobs.find((j) => j.id === 'intercom-7591182');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, Inbox');
      // D-10: this fixture title is already trimmed, so .trim() is
      // idempotent here and the emitted title equals the wire title
      // byte-for-byte.
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(eng?.companyName).toBe('Intercom');
      expect(eng?.location?.city).toBe('Dublin, Ireland');
      // The fixture location string does NOT contain "Remote" (Dublin
      // hybrid string, no remote keyword) so isRemote should be false.
      expect(eng?.isRemote).toBe(false);
      // D-11 second-instance pass-through guard for the flat-name
      // department format — distinct token from the first listing.
      expect(eng?.department).toBe('Engineering');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('Inbox');
      expect(eng?.description).toContain('Fin AI agent');

      // Regression guard: the slug must be `intercom` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/intercom/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IntercomService();
      const input: ScraperInputDto = {
        siteType: [Site.INTERCOM],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (post-trim — D-10 guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IntercomService();
      // 'COMMERCIAL' (uppercase) tests both case-insensitivity AND the
      // post-trim search — the wire fixture title for the first
      // listing has a trailing space pad that the .trim() in the
      // service strips before the searchTerm filter runs, so this
      // filter must match the trimmed title's trailing-edge token
      // `'Commercial'` rather than the wire `'Commercial '` form.
      const result = await service.scrape({
        siteType: [Site.INTERCOM],
        searchTerm: 'COMMERCIAL',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('intercom-7247950');
      expect(result.jobs[0].title).toBe('Account Executive, Commercial');
    });

    it('filters by case-insensitive substring of department name (D-11 flat-name search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IntercomService();
      const result = await service.scrape({
        siteType: [Site.INTERCOM],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the second fixture job has `'Engineering'` as its flat
      // single-token department; the case-insensitive match on the
      // literal `'engineering'` substring matches the literal
      // `'Engineering'` department name in the second listing.
      // The first listing's title-search miss ('Account Executive,
      // Commercial' does not contain 'engineering' after lowercasing)
      // and dept miss ('Sales' does not contain 'engineering') filter
      // it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('intercom-7591182');
      expect(result.jobs[0].department).toBe('Engineering');
    });

    it('filters by case-insensitive substring of department name on first listing — D-11 sales lock', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IntercomService();
      const result = await service.scrape({
        siteType: [Site.INTERCOM],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Only the first fixture job has `'Sales'` as its flat
      // single-token department. The case-insensitive match on the
      // literal `'sales'` substring matches `'Sales'` in the first
      // listing. The second listing's title-search miss ('Senior
      // Software Engineer, Inbox' does not contain 'sales') and dept
      // miss ('Engineering' does not contain 'sales') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('intercom-7247950');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new IntercomService();
      const result = await service.scrape({
        siteType: [Site.INTERCOM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new IntercomService();
      const result = await service.scrape({
        siteType: [Site.INTERCOM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
