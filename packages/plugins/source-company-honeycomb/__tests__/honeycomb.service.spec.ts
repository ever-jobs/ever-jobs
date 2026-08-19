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

import { HoneycombModule, HoneycombService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'honeycomb-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 073 / T04 — `HoneycombService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `HoneycombService` through `HoneycombModule`.
 *   2. `Site.HONEYCOMB === 'honeycomb'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `honeycomb`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-2 modern hosted-board
 *      `job-boards.greenhouse.io/honeycomb/jobs/<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — fifteenth plugin in the
 *      cohort to use variant 2), (d) the emitted `companyName` is the
 *      TLD-suffix wire `'Honeycomb.io'` byte-for-byte AND matches the
 *      wire `company_name` byte-for-byte AND is byte-distinct from
 *      the slug `honeycomb` AND is exactly **3 bytes longer** than
 *      the slug (locking the slug/wire TLD-suffix asymmetry — D-09
 *      omission lock, the **first** cohort case where the wire
 *      carries the brand's TLD as a 3-byte trailing suffix), (e)
 *      **D-10 trim lock** — the emitted `title` for the SECOND
 *      listing equals trimmed form `'Staff Solution Architect'` AND
 *      is byte-distinct from wire-padded form `'Staff Solution
 *      Architect '` AND is exactly **1 byte shorter** (locking the
 *      single-trailing-pad form), (f) the emitted `department` for
 *      the FIRST listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Sales'` — clean single-token form, D-11
 *      pass-through), and (g) the emitted `department` for the
 *      SECOND listing matches the wire `departments[0].name` byte-
 *      for-byte (`'Finance & Accounting'` — clean multi-token form
 *      with internal ampersand and whitespace, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('HoneycombService — Spec 073 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through HoneycombModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [HoneycombModule],
      }).compile();
      const service = moduleRef.get(HoneycombService);
      expect(service).toBeInstanceOf(HoneycombService);
      await moduleRef.close();
    });

    it('exports the Site.HONEYCOMB = "honeycomb" enum value', () => {
      expect(Site.HONEYCOMB).toBe('honeycomb');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HoneycombService();
      const input: ScraperInputDto = {
        siteType: [Site.HONEYCOMB],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eae = dto.jobs.find((j) => j.id === 'honeycomb-5202308008');
      expect(eae).toBeDefined();
      expect(eae?.site).toBe(Site.HONEYCOMB);
      // D-09 omission lock with TLD-suffix wire variant: the
      // emitted `companyName` is the TLD-suffix `'Honeycomb.io'`
      // byte-for-byte AND matches the wire `company_name`
      // byte-for-byte AND is byte-distinct from the slug
      // `honeycomb` AND is exactly 3 bytes longer than the slug
      // (locking the .io TLD-suffix asymmetry — first cohort
      // observation of this asymmetry shape). Twenty-third cohort
      // plugin to omit D-09.
      expect(eae?.companyName).toBe('Honeycomb.io');
      expect(eae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(eae?.companyName).not.toBe('honeycomb');
      expect(eae?.companyName!.length).toBe('honeycomb'.length + 3);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(eae?.title).toBe('Enterprise Account Executive - Benelux');
      expect(eae?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Honeycomb's tenant publishes `absolute_url` on
      // wire-shape variant 2 — the modern
      // `https://job-boards.greenhouse.io/honeycomb/jobs/<id>` shape.
      // The plugin emits `listing.absolute_url` byte-for-byte.
      // Fifteenth plugin in the cohort to use variant 2.
      expect(eae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/honeycomb/jobs/5202308008',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io/honeycomb/jobs/` substring
      // (variant-2 modern apex) AND must NOT contain `?gh_jid=`
      // (locking the variant-2 shape against future refactors that
      // might naively normalise to variant 10).
      expect(eae?.jobUrl).toContain('job-boards.greenhouse.io/honeycomb/jobs/');
      expect(eae?.jobUrl).not.toContain('?gh_jid=');
      // Location — Honeycomb wire is fully clean (D-12 not applied).
      // Remote-detection picks up the literal `remote` substring
      // case-insensitively.
      expect(eae?.location?.city).toBe('Remote - United Kingdom');
      expect(eae?.isRemote).toBe(true);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Sales'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity to
      // the wire shape).
      expect(eae?.department).toBe('Sales');
      expect(eae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&quot;` (named entities not decoded), `&amp;` (ampersand
      // entities not decoded), or literal `<p>`/`<div>`/`<strong>`/
      // `<em>` (tags not stripped after decode).
      expect(eae?.description).not.toContain('&lt;');
      expect(eae?.description).not.toContain('&quot;');
      expect(eae?.description).not.toContain('&amp;');
      expect(eae?.description).not.toContain('<p>');
      expect(eae?.description).not.toContain('<div>');
      expect(eae?.description).not.toContain('<strong>');
      expect(eae?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(eae?.description).toContain('Honeycomb');
      expect(eae?.description).toContain('Sales');

      const ssa = dto.jobs.find((j) => j.id === 'honeycomb-5162709008');
      expect(ssa).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Staff Solution Architect'` (no trailing pad bytes)
      // AND is byte-distinct from the wire form `'Staff Solution
      // Architect '` (with one trailing pad byte) AND is exactly 1
      // byte shorter. Fourteenth cohort plugin to apply D-10.
      expect(ssa?.title).toBe('Staff Solution Architect');
      expect(ssa?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Staff Solution Architect ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(ssa?.title.endsWith(' ')).toBe(false);
      expect(ssa?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(ssa?.companyName).toBe('Honeycomb.io');
      expect(ssa?.location?.city).toBe('Remote - Canada');
      expect(ssa?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Finance & Accounting'`
      // byte-for-byte (clean multi-token form with internal
      // ampersand and whitespace; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(ssa?.department).toBe('Finance & Accounting');
      expect(ssa?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-2 lock for the second listing too.
      expect(ssa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/honeycomb/jobs/5162709008',
      );
      expect(ssa?.jobUrl).toContain('job-boards.greenhouse.io/honeycomb/jobs/');
      expect(ssa?.jobUrl).not.toContain('?gh_jid=');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(ssa?.description).not.toContain('<p>');
      expect(ssa?.description).not.toContain('<strong>');
      expect(ssa?.description).toContain('Solution Architect');
      expect(ssa?.description).toContain('Finance');

      // Regression guard: the slug must be `honeycomb` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/honeycomb/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HoneycombService();
      const input: ScraperInputDto = {
        siteType: [Site.HONEYCOMB],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HoneycombService();
      const result = await service.scrape({
        siteType: [Site.HONEYCOMB],
        searchTerm: 'ARCHITECT',
      } as ScraperInputDto);

      // Only the second fixture job has 'Architect' in its title
      // (trimmed `'Staff Solution Architect'`); the case-insensitive
      // match on the literal `'ARCHITECT'` substring matches the
      // trimmed second listing's title byte-for-byte. The first
      // listing's title ('Enterprise Account Executive - Benelux')
      // and dept ('Sales') do not contain 'architect', so it filters
      // out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('honeycomb-5162709008');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('Staff Solution Architect');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HoneycombService();
      const result = await service.scrape({
        siteType: [Site.HONEYCOMB],
        searchTerm: 'finance',
      } as ScraperInputDto);

      // Only the second fixture job has `'Finance & Accounting'` as
      // its department; the case-insensitive match on the literal
      // `'finance'` substring matches the literal `'Finance &
      // Accounting'` department name. The first listing's title
      // ('Enterprise Account Executive - Benelux') and dept
      // ('Sales') do not contain 'finance', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('honeycomb-5162709008');
      expect(result.jobs[0].department).toBe('Finance & Accounting');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new HoneycombService();
      const result = await service.scrape({
        siteType: [Site.HONEYCOMB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new HoneycombService();
      const result = await service.scrape({
        siteType: [Site.HONEYCOMB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
