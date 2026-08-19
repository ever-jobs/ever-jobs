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

import { MixpanelModule, MixpanelService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'mixpanel-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 062 / T04 — `MixpanelService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MixpanelService` through `MixpanelModule`.
 *   2. `Site.MIXPANEL === 'mixpanel'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `mixpanel` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-2 US-region permalink
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/mixpanel/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the brand name `'Mixpanel'` byte-for-
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
describe('MixpanelService — Spec 062 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MixpanelModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MixpanelModule],
      }).compile();
      const service = moduleRef.get(MixpanelService);
      expect(service).toBeInstanceOf(MixpanelService);
      await moduleRef.close();
    });

    it('exports the Site.MIXPANEL = "mixpanel" enum value', () => {
      expect(Site.MIXPANEL).toBe('mixpanel');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MixpanelService();
      const input: ScraperInputDto = {
        siteType: [Site.MIXPANEL],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const am = dto.jobs.find((j) => j.id === 'mixpanel-7246274');
      expect(am).toBeDefined();
      expect(am?.site).toBe(Site.MIXPANEL);
      // D-09 omission lock: the emitted `companyName` is the brand
      // name `'Mixpanel'` byte-for-byte AND matches the wire
      // `company_name` byte-for-byte (locking the wire-shape regression
      // guard against the upstream tenant adding a future legal-entity
      // suffix). The plugin reads `listing.company_name` directly.
      expect(am?.companyName).toBe('Mixpanel');
      expect(am?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 first-instance regression guard: the wire fixture title
      // `'Account Manager '` (with trailing ASCII space) is observably
      // trimmed to `'Account Manager'` (no trailing space). Asserting
      // both halves: the emitted title is the trimmed form AND the
      // trim observably fired (emitted !== fixture).
      expect(am?.title).toBe('Account Manager');
      expect(am?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(am?.title).toBe(am?.title?.trim());
      // Wire shape: Mixpanel's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // mixpanel/jobs/<id>` — variant 2 (the eleventh plugin in the
      // cohort to use this shape) (Spec 062 § 10 D-04).
      expect(am?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/mixpanel/jobs/7246274',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/mixpanel/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a variant-10 or
      // variant-11 template).
      expect(am?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(am?.jobUrl).toContain('/mixpanel/jobs/');
      expect(am?.jobUrl).not.toContain('?gh_jid=');
      expect(am?.location?.city).toBe('San Francisco, CA');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the flat single-token string `'Sales'`
      // byte-for-byte AND matches the wire `departments[0].name`
      // byte-for-byte (Mixpanel uses simple flat single-token
      // department names like Intercom and Attentive, distinct from
      // Elastic's compound `' - '`-separated regional-scoped format,
      // ZoomInfo's numeric-code-prefix format, and Toast's
      // colon-separated nested-path format).
      expect(am?.department).toBe('Sales');
      expect(am?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(am?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(am?.description).not.toContain('&lt;');
      expect(am?.description).not.toContain('&quot;');
      expect(am?.description).not.toContain('&#39;');
      expect(am?.description).not.toContain('<p>');
      expect(am?.description).not.toContain('<div>');
      expect(am?.description).not.toContain('<strong>');
      expect(am?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(am?.description).toContain('Mixpanel');
      expect(am?.description).toContain('Account Manager');
      expect(am?.description).toContain('Mixpanel Analytics');

      const eng = dto.jobs.find((j) => j.id === 'mixpanel-7665696');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, Insights');
      // D-10: this fixture title is already trimmed, so .trim() is
      // idempotent here and the emitted title equals the wire title
      // byte-for-byte.
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(eng?.companyName).toBe('Mixpanel');
      expect(eng?.location?.city).toBe('Bangalore, India');
      // The fixture location string does NOT contain "Remote"
      // (Bangalore hybrid string, no remote keyword) so isRemote
      // should be false.
      expect(eng?.isRemote).toBe(false);
      // D-11 second-instance pass-through guard for the flat-name
      // department format — distinct token from the first listing.
      expect(eng?.department).toBe('Engineering');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('Insights');
      expect(eng?.description).toContain('ClickHouse');

      // Regression guard: the slug must be `mixpanel` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/mixpanel/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MixpanelService();
      const input: ScraperInputDto = {
        siteType: [Site.MIXPANEL],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (post-trim — D-10 guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MixpanelService();
      // 'MANAGER' (uppercase) tests both case-insensitivity AND the
      // post-trim search — the wire fixture title for the first
      // listing has a trailing space pad that the .trim() in the
      // service strips before the searchTerm filter runs, so this
      // filter must match the trimmed title's trailing-edge token
      // `'Manager'` rather than the wire `'Manager '` form.
      const result = await service.scrape({
        siteType: [Site.MIXPANEL],
        searchTerm: 'MANAGER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mixpanel-7246274');
      expect(result.jobs[0].title).toBe('Account Manager');
    });

    it('filters by case-insensitive substring of department name (D-11 flat-name search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MixpanelService();
      const result = await service.scrape({
        siteType: [Site.MIXPANEL],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the second fixture job has `'Engineering'` as its flat
      // single-token department; the case-insensitive match on the
      // literal `'engineering'` substring matches the literal
      // `'Engineering'` department name in the second listing.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mixpanel-7665696');
      expect(result.jobs[0].department).toBe('Engineering');
    });

    it('filters by case-insensitive substring of department name on first listing — D-11 sales lock', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MixpanelService();
      const result = await service.scrape({
        siteType: [Site.MIXPANEL],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Only the first fixture job has `'Sales'` as its flat
      // single-token department. The case-insensitive match on the
      // literal `'sales'` substring matches `'Sales'` in the first
      // listing. The second listing's title-search miss ('Senior
      // Software Engineer, Insights' does not contain 'sales') and
      // dept miss ('Engineering' does not contain 'sales') filter it
      // out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mixpanel-7246274');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MixpanelService();
      const result = await service.scrape({
        siteType: [Site.MIXPANEL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MixpanelService();
      const result = await service.scrape({
        siteType: [Site.MIXPANEL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
