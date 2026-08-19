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

import { CourseraModule, CourseraService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'coursera-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 068 / T04 — `CourseraService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CourseraService` through `CourseraModule`.
 *   2. `Site.COURSERA === 'coursera'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `coursera`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-2
 *      `job-boards.greenhouse.io/coursera/jobs/<id>` `absolute_url`
 *      flows through byte-for-byte (D-04), (d) the emitted
 *      `companyName` is the single-token bare-brand display
 *      `'Coursera'` byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      for both listings matches the wire `title` byte-for-byte (D-10
 *      omission lock — no `.trim()` applied), (f) the emitted
 *      `department` for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Chief of Staff'` —
 *      clean multi-token form, D-11 pass-through), and (g) the
 *      emitted `department` for the SECOND listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Industry Partnerships'`
 *      — clean multi-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CourseraService — Spec 068 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CourseraModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CourseraModule],
      }).compile();
      const service = moduleRef.get(CourseraService);
      expect(service).toBeInstanceOf(CourseraService);
      await moduleRef.close();
    });

    it('exports the Site.COURSERA = "coursera" enum value', () => {
      expect(Site.COURSERA).toBe('coursera');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CourseraService();
      const input: ScraperInputDto = {
        siteType: [Site.COURSERA],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cos = dto.jobs.find((j) => j.id === 'coursera-5982730004');
      expect(cos).toBeDefined();
      expect(cos?.site).toBe(Site.COURSERA);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand display `'Coursera'` byte-for-byte
      // AND matches the wire `company_name` byte-for-byte.
      // Eighteenth cohort plugin to omit D-09.
      expect(cos?.companyName).toBe('Coursera');
      expect(cos?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 omission lock: emitted `title` matches the wire `title`
      // byte-for-byte (no `.trim()` applied — the wire titles are
      // trim-clean, 0 of 8 padded in run-278 probe).
      expect(cos?.title).toBe('Chief of Staff - CTO');
      expect(cos?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Coursera's tenant publishes `absolute_url` on
      // wire-shape variant 2 — the modern US-region permalink
      // subdomain `https://job-boards.greenhouse.io/coursera/jobs/<id>`
      // shape. The plugin emits `listing.absolute_url` byte-for-byte.
      expect(cos?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/coursera/jobs/5982730004',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io/coursera/jobs/` substring (variant-2
      // canonical Greenhouse shape) — locking the variant-2 shape
      // against future refactors that might naively normalise to a
      // different variant.
      expect(cos?.jobUrl).toContain('job-boards.greenhouse.io/coursera/jobs/');
      expect(cos?.location?.city).toBe('United States');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Chief of Staff'` byte-for-byte
      // (clean multi-token form; pass-through preserves byte-fidelity
      // to the wire shape).
      expect(cos?.department).toBe('Chief of Staff');
      expect(cos?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(cos?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&amp;` (ampersand entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(cos?.description).not.toContain('&lt;');
      expect(cos?.description).not.toContain('&quot;');
      expect(cos?.description).not.toContain('&amp;');
      expect(cos?.description).not.toContain('<p>');
      expect(cos?.description).not.toContain('<div>');
      expect(cos?.description).not.toContain('<strong>');
      expect(cos?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(cos?.description).toContain('Coursera');
      expect(cos?.description).toContain('Andrew Ng');

      const cit = dto.jobs.find((j) => j.id === 'coursera-5839408004');
      expect(cit).toBeDefined();
      // D-10 omission lock for the second listing: emitted `title`
      // matches the wire `title` byte-for-byte (the wire title
      // contains a literal `&` byte in 'Content Ingestion &
      // Transformation Specialist' — distinct from the entity
      // `&amp;` form Greenhouse uses inside the `content` field).
      expect(cit?.title).toBe('Content Ingestion & Transformation Specialist');
      expect(cit?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(cit?.companyName).toBe('Coursera');
      expect(cit?.location?.city).toBe('India');
      expect(cit?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Industry Partnerships'`
      // byte-for-byte (clean multi-token form; pass-through preserves
      // byte-fidelity).
      expect(cit?.department).toBe('Industry Partnerships');
      expect(cit?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-2 lock for the second listing too.
      expect(cit?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/coursera/jobs/5839408004',
      );
      expect(cit?.jobUrl).toContain('job-boards.greenhouse.io/coursera/jobs/');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(cit?.description).not.toContain('<p>');
      expect(cit?.description).not.toContain('<h2>');
      expect(cit?.description).toContain('Content Ingestion');
      expect(cit?.description).toContain('Industry Partnerships');

      // Regression guard: the slug must be `coursera` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/coursera/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CourseraService();
      const input: ScraperInputDto = {
        siteType: [Site.COURSERA],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CourseraService();
      const result = await service.scrape({
        siteType: [Site.COURSERA],
        searchTerm: 'CHIEF',
      } as ScraperInputDto);

      // Only the first fixture job has 'Chief' in its title
      // ('Chief of Staff - CTO'); the case-insensitive match on the
      // literal 'CHIEF' substring matches it. The second listing's
      // title ('Content Ingestion & Transformation Specialist') and
      // department ('Industry Partnerships') do not contain 'chief',
      // so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coursera-5982730004');
      expect(result.jobs[0].title).toBe('Chief of Staff - CTO');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CourseraService();
      const result = await service.scrape({
        siteType: [Site.COURSERA],
        searchTerm: 'partnerships',
      } as ScraperInputDto);

      // Only the second fixture job has 'Partnerships' as part of
      // its department ('Industry Partnerships'); the case-insensitive
      // match on the literal 'partnerships' substring matches it.
      // The first listing's title ('Chief of Staff - CTO') and dept
      // ('Chief of Staff') do not contain 'partnerships', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coursera-5839408004');
      expect(result.jobs[0].department).toBe('Industry Partnerships');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CourseraService();
      const result = await service.scrape({
        siteType: [Site.COURSERA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CourseraService();
      const result = await service.scrape({
        siteType: [Site.COURSERA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
