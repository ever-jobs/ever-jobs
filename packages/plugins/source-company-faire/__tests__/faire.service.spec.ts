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

import { FaireModule, FaireService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'faire-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 063 / T04 — `FaireService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FaireService` through `FaireModule`.
 *   2. `Site.FAIRE === 'faire'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `faire` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-10 legacy hosted-board
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `boards.greenhouse.io/faire/jobs/<id>?gh_jid=<id>` shape), (d)
 *      the emitted `companyName` is the brand name `'Faire'` byte-for-
 *      byte AND matches the wire `company_name` byte-for-byte (D-09
 *      omission lock — regression guard against the upstream tenant
 *      adding a future legal-entity suffix), (e) the emitted `title`
 *      has no leading or trailing whitespace AND for the padded-
 *      fixture-listing case the emitted `title !== fixture.title`
 *      (D-10 wire-title trim observability), and (f) the emitted
 *      `department` for the first listing matches the wire
 *      `departments[0].name` byte-for-byte (D-11 multi-word
 *      pass-through guard).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive) — the
 *      filter must work post-trim (D-10 trim-then-match guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'support'` substring matching the
 *      multi-word department in the first listing).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('FaireService — Spec 063 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FaireModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FaireModule],
      }).compile();
      const service = moduleRef.get(FaireService);
      expect(service).toBeInstanceOf(FaireService);
      await moduleRef.close();
    });

    it('exports the Site.FAIRE = "faire" enum value', () => {
      expect(Site.FAIRE).toBe('faire');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FaireService();
      const input: ScraperInputDto = {
        siteType: [Site.FAIRE],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const designer = dto.jobs.find((j) => j.id === 'faire-8510205002');
      expect(designer).toBeDefined();
      expect(designer?.site).toBe(Site.FAIRE);
      // D-09 omission lock: the emitted `companyName` is the brand
      // name `'Faire'` byte-for-byte AND matches the wire
      // `company_name` byte-for-byte (locking the wire-shape regression
      // guard against the upstream tenant adding a future legal-entity
      // suffix). The plugin reads `listing.company_name` directly.
      expect(designer?.companyName).toBe('Faire');
      expect(designer?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 first-instance regression guard: the wire fixture title
      // `'Production Designer, Brand '` (with trailing ASCII space) is
      // observably trimmed to `'Production Designer, Brand'` (no
      // trailing space). Asserting both halves: the emitted title is
      // the trimmed form AND the trim observably fired (emitted !==
      // fixture).
      expect(designer?.title).toBe('Production Designer, Brand');
      expect(designer?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(designer?.title).toBe(designer?.title?.trim());
      // Wire shape: Faire's tenant publishes `absolute_url` on the
      // legacy hosted-board apex `boards.greenhouse.io/faire/jobs/
      // <id>?gh_jid=<id>` — variant 10 (the second plugin in the
      // cohort to use this shape after Chime) (Spec 063 § 10 D-04).
      expect(designer?.jobUrl).toBe(
        'https://boards.greenhouse.io/faire/jobs/8510205002?gh_jid=8510205002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `boards.greenhouse.io` substring (legacy hosted-board apex)
      // AND the literal `/faire/jobs/` substring AND the literal
      // `?gh_jid=` substring AND must NOT contain
      // `job-boards.greenhouse.io` (locking the variant-10 shape
      // against future refactors that might naively normalise to a
      // variant-2 or variant-11 template).
      expect(designer?.jobUrl).toContain('boards.greenhouse.io');
      expect(designer?.jobUrl).toContain('/faire/jobs/');
      expect(designer?.jobUrl).toContain('?gh_jid=');
      expect(designer?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(designer?.location?.city).toBe('San Francisco, CA');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the multi-word descriptive string
      // `'Customer Support Management'` byte-for-byte AND matches the
      // wire `departments[0].name` byte-for-byte (Faire uses
      // descriptive multi-word department names, distinct from
      // Mixpanel's flat single-token, Elastic's compound `' - '`-
      // separated regional-scoped, and Toast's colon-separated
      // nested-path formats).
      expect(designer?.department).toBe('Customer Support Management');
      expect(designer?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(designer?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(designer?.description).not.toContain('&lt;');
      expect(designer?.description).not.toContain('&quot;');
      expect(designer?.description).not.toContain('&#39;');
      expect(designer?.description).not.toContain('<p>');
      expect(designer?.description).not.toContain('<div>');
      expect(designer?.description).not.toContain('<strong>');
      expect(designer?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(designer?.description).toContain('Faire');
      expect(designer?.description).toContain('Production Designer');
      expect(designer?.description).toContain('Brand');

      const eng = dto.jobs.find((j) => j.id === 'faire-8400765002');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, Marketplace');
      // D-10: this fixture title is already trimmed, so .trim() is
      // idempotent here and the emitted title equals the wire title
      // byte-for-byte.
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(eng?.companyName).toBe('Faire');
      expect(eng?.location?.city).toBe('Toronto, Canada');
      // The fixture location string does NOT contain "Remote"
      // (Toronto hybrid string, no remote keyword) so isRemote
      // should be false.
      expect(eng?.isRemote).toBe(false);
      // D-11 second-instance pass-through guard for the multi-word
      // department format — distinct token from the first listing.
      expect(eng?.department).toBe('Engineering');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('Marketplace');
      expect(eng?.description).toContain('Postgres');

      // Regression guard: the slug must be `faire` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/faire/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FaireService();
      const input: ScraperInputDto = {
        siteType: [Site.FAIRE],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (post-trim — D-10 guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FaireService();
      // 'DESIGNER' (uppercase) tests both case-insensitivity AND the
      // post-trim search — the wire fixture title for the first
      // listing has a trailing space pad that the .trim() in the
      // service strips before the searchTerm filter runs, so this
      // filter must match the trimmed title's trailing-edge token
      // `'Brand'` rather than the wire `'Brand '` form.
      const result = await service.scrape({
        siteType: [Site.FAIRE],
        searchTerm: 'DESIGNER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('faire-8510205002');
      expect(result.jobs[0].title).toBe('Production Designer, Brand');
    });

    it('filters by case-insensitive substring of department name (D-11 multi-word search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FaireService();
      const result = await service.scrape({
        siteType: [Site.FAIRE],
        searchTerm: 'support',
      } as ScraperInputDto);

      // Only the first fixture job has `'Customer Support Management'`
      // as its department; the case-insensitive match on the literal
      // `'support'` substring matches the literal `'Support'` token in
      // the multi-word department name.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('faire-8510205002');
      expect(result.jobs[0].department).toBe('Customer Support Management');
    });

    it('filters by case-insensitive substring of department name on second listing — D-11 engineering lock', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FaireService();
      const result = await service.scrape({
        siteType: [Site.FAIRE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the second fixture job has `'Engineering'` as its
      // department. The case-insensitive match on the literal
      // `'engineering'` substring matches `'Engineering'` in the
      // second listing. The first listing's title-search miss
      // ('Production Designer, Brand' does not contain 'engineering')
      // and dept miss ('Customer Support Management' does not contain
      // 'engineering') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('faire-8400765002');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FaireService();
      const result = await service.scrape({
        siteType: [Site.FAIRE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FaireService();
      const result = await service.scrape({
        siteType: [Site.FAIRE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
