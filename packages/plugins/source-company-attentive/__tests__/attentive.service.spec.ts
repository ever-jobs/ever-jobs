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

import { AttentiveModule, AttentiveService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'attentive-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 058 / T04 — `AttentiveService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AttentiveService` through `AttentiveModule`.
 *   2. `Site.ATTENTIVE === 'attentive'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `attentive` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-2 US-region permalink
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/attentive/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the brand name `'Attentive'` byte-for-
 *      byte AND matches the wire `company_name` byte-for-byte (D-09
 *      regression guard against the upstream tenant adding a future
 *      legal-entity suffix), (e) the emitted `title` has no leading
 *      or trailing whitespace AND for the padded-fixture-listing case
 *      the emitted `title !== fixture.title` (D-10 wire-title trim
 *      observability), and (f) the emitted `department` for the first
 *      listing matches the wire `departments[0].name` byte-for-byte
 *      (D-11 first-instance pass-through guard for the flat-name
 *      department format).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive) — even
 *      after the D-10 wire-title trim observably fires.
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'engineering'` substring matching the
 *      flat single-token department in the second listing).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('AttentiveService — Spec 058 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AttentiveModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AttentiveModule],
      }).compile();
      const service = moduleRef.get(AttentiveService);
      expect(service).toBeInstanceOf(AttentiveService);
      await moduleRef.close();
    });

    it('exports the Site.ATTENTIVE = "attentive" enum value', () => {
      expect(Site.ATTENTIVE).toBe('attentive');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AttentiveService();
      const input: ScraperInputDto = {
        siteType: [Site.ATTENTIVE],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'attentive-4187911009');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.ATTENTIVE);
      // D-09 regression guard: the emitted `companyName` is the brand
      // name `'Attentive'` byte-for-byte AND matches the wire
      // `company_name` byte-for-byte (locking the wire-shape regression
      // guard against the upstream tenant adding a future legal-entity
      // suffix).
      expect(ae?.companyName).toBe('Attentive');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ae?.title).toBe('Accounting Manager');
      // D-10 lock: the first fixture title is already trimmed so the
      // `.trim()` is idempotent here, but the test still asserts the
      // emitted `title` has no leading or trailing whitespace.
      expect(ae?.title).toBe(ae?.title?.trim());
      // Wire shape: Attentive's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // attentive/jobs/<id>` — variant 2 (the ninth plugin in the
      // cohort to use this shape) (Spec 058 § 10 D-04).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/attentive/jobs/4187911009',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/attentive/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a marketing-site
      // template).
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(ae?.jobUrl).toContain('/attentive/jobs/');
      expect(ae?.jobUrl).not.toContain('?gh_jid=');
      expect(ae?.location?.city).toBe('United States');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the flat single-token string `'Finance'`
      // byte-for-byte AND matches the wire `departments[0].name`
      // byte-for-byte (Attentive uses simple flat single-token
      // department names, distinct from ZoomInfo's numeric-code-prefix
      // and Toast's colon-separated nested-path formats).
      expect(ae?.department).toBe('Finance');
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
      expect(ae?.description).toContain('Attentive');
      expect(ae?.description).toContain('Accounting Manager');
      expect(ae?.description).toContain('month-end close');

      const dir = dto.jobs.find((j) => j.id === 'attentive-4221431009');
      expect(dir).toBeDefined();
      // D-10 first-instance regression guard: the wire fixture title
      // `'Director of Engineering, Intelligent Messaging '` (with
      // trailing ASCII space) is observably trimmed to `'Director of
      // Engineering, Intelligent Messaging'` (no trailing space).
      // Asserting both halves: the emitted title is the trimmed form
      // AND the trim observably fired (emitted !== fixture).
      expect(dir?.title).toBe('Director of Engineering, Intelligent Messaging');
      expect(dir?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(dir?.companyName).toBe('Attentive');
      expect(dir?.location?.city).toBe('New York, NY');
      // The fixture location string does NOT contain "Remote" (NYC
      // hybrid string, no remote keyword) so isRemote should be false.
      expect(dir?.isRemote).toBe(false);
      // D-11 second-instance pass-through guard for the flat-name
      // department format — distinct token from the first listing.
      expect(dir?.department).toBe('Engineering');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(dir?.description).not.toContain('<p>');
      expect(dir?.description).toContain('Intelligent Messaging');
      expect(dir?.description).toContain('Attentive Concierge');

      // Regression guard: the slug must be `attentive` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/attentive/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AttentiveService();
      const input: ScraperInputDto = {
        siteType: [Site.ATTENTIVE],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (post-trim)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AttentiveService();
      // 'MESSAGING' (uppercase) tests both case-insensitivity AND the
      // post-trim search — the wire fixture title for the second
      // listing has a trailing space pad that the .trim() in the
      // service strips before the searchTerm filter runs, so this
      // filter must match the trimmed title's trailing-edge token
      // `'Messaging'` rather than the wire `'Messaging '` form.
      const result = await service.scrape({
        siteType: [Site.ATTENTIVE],
        searchTerm: 'MESSAGING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('attentive-4221431009');
      expect(result.jobs[0].title).toBe('Director of Engineering, Intelligent Messaging');
    });

    it('filters by case-insensitive substring of department name (D-11 flat-name search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AttentiveService();
      const result = await service.scrape({
        siteType: [Site.ATTENTIVE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the second fixture job has `'Engineering'` as its flat
      // single-token department; the case-insensitive match on the
      // literal `'engineering'` substring matches the literal
      // `'Engineering'` department name in the second listing.
      // The first listing's title-search miss ('Accounting Manager'
      // does not contain 'engineering' after lowercasing) and dept
      // miss ('Finance' does not contain 'engineering') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('attentive-4221431009');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AttentiveService();
      const result = await service.scrape({
        siteType: [Site.ATTENTIVE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AttentiveService();
      const result = await service.scrape({
        siteType: [Site.ATTENTIVE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
