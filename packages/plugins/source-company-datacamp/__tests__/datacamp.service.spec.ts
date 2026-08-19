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

import { DatacampModule, DatacampService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'datacamp-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 081 / T04 — `DatacampService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DatacampService` through `DatacampModule`.
 *   2. `Site.DATACAMP === 'datacamp'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `datacamp`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the canonical variant-2
 *      `job-boards.greenhouse.io/datacamp/jobs/<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — twenty-first cohort
 *      plugin to use canonical variant 2), (d) the emitted
 *      `companyName` is the slug/wire-asymmetric PascalCase wire
 *      `'DataCamp'` byte-for-byte AND matches the wire
 *      `company_name` byte-for-byte AND is case-insensitively-equal
 *      to the lowercase slug `datacamp` (locking the slug/wire
 *      asymmetry — wire 8 bytes, slug 8 bytes, single internal-
 *      capital `C` byte difference at offset 4), (e) the emitted
 *      `department` for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Learner Product'` —
 *      clean multi-token form, D-11 trim is a no-op on this
 *      listing), and (f) **D-11 leading-pad lock** — the emitted
 *      `department` for the SECOND listing equals trimmed form
 *      `'IT'` AND is byte-distinct from wire-padded form `' IT'`
 *      AND is exactly **1 byte shorter** AND does NOT start with
 *      a leading ASCII space (locking the single-leading-pad form
 *      — first cohort observation of D-11 with leading-pad).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive, against the trimmed form — D-11 search guard
 *      for leading-pad case: searching `'it'` matches the trimmed
 *      `'IT'` even though the wire is the padded `' IT'`).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DatacampService — Spec 081 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DatacampModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DatacampModule],
      }).compile();
      const service = moduleRef.get(DatacampService);
      expect(service).toBeInstanceOf(DatacampService);
      await moduleRef.close();
    });

    it('exports the Site.DATACAMP = "datacamp" enum value', () => {
      expect(Site.DATACAMP).toBe('datacamp');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatacampService();
      const input: ScraperInputDto = {
        siteType: [Site.DATACAMP],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const curriculum = dto.jobs.find((j) => j.id === 'datacamp-7067243');
      expect(curriculum).toBeDefined();
      expect(curriculum?.site).toBe(Site.DATACAMP);
      // D-09 omission lock with slug/wire-asymmetric internal-capital
      // wire variant: the emitted `companyName` is the PascalCase
      // wire `'DataCamp'` byte-for-byte AND matches the wire
      // `company_name` byte-for-byte AND is case-insensitively-equal
      // to the lowercase slug `datacamp` (slug 8 bytes, wire 8
      // bytes — same byte count; differ only at offset 4 where the
      // wire has `C` and the slug has `c` — pure case-fold
      // asymmetry, NOT an extra TLD/space/acronym suffix).
      expect(curriculum?.companyName).toBe('DataCamp');
      expect(curriculum?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(curriculum?.companyName?.toLowerCase()).toBe('datacamp');
      expect(curriculum?.companyName?.length).toBe('datacamp'.length);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(curriculum?.title).toBe('Curriculum Manager - Data Science and AI');
      expect(curriculum?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: DataCamp's tenant publishes `absolute_url` on
      // canonical Greenhouse wire-shape variant 2 — the
      // `https://job-boards.greenhouse.io/datacamp/jobs/<id>` shape.
      // The plugin emits `listing.absolute_url` byte-for-byte.
      // Twenty-first cohort plugin to use canonical variant 2.
      expect(curriculum?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/datacamp/jobs/7067243',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io/datacamp/jobs/` substring AND must
      // NOT contain the trailing-slash-before-query `/?gh_jid=`
      // substring (locking the variant-2 baseline shape against
      // any cross-pollination from variant-18 patterns). It must
      // NOT contain `datacamp.com/careers/` (locking the variant-2
      // shape against falling back to a bare brand-domain shape).
      expect(curriculum?.jobUrl).toContain('job-boards.greenhouse.io/datacamp/jobs/');
      expect(curriculum?.jobUrl).not.toContain('/?gh_jid=');
      expect(curriculum?.jobUrl).not.toContain('datacamp.com/careers/');
      // Location — DataCamp's multi-region location form.
      expect(curriculum?.location?.city).toBe(
        'Belgium; Portugal; United Kingdom; United States',
      );
      expect(curriculum?.isRemote).toBe(false);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Learner Product'` byte-for-byte
      // (clean multi-token form; trim is a no-op on this listing).
      expect(curriculum?.department).toBe('Learner Product');
      expect(curriculum?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&amp;` (ampersand entities not decoded), `&quot;` (named
      // entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<strong>` (tags not stripped
      // after decode).
      expect(curriculum?.description).not.toContain('&lt;');
      expect(curriculum?.description).not.toContain('&amp;');
      expect(curriculum?.description).not.toContain('&quot;');
      expect(curriculum?.description).not.toContain('&#39;');
      expect(curriculum?.description).not.toContain('<p>');
      expect(curriculum?.description).not.toContain('<strong>');
      // Sanity: the role-specific body content survives the strip.
      expect(curriculum?.description).toContain('DataCamp');
      expect(curriculum?.description).toContain('Learner Product');

      const sre = dto.jobs.find((j) => j.id === 'datacamp-7531007');
      expect(sre).toBeDefined();
      // Second-listing title is wire-clean (D-10 omitted).
      expect(sre?.title).toBe('Senior Data Engineer');
      expect(sre?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(sre?.companyName).toBe('DataCamp');
      expect(sre?.location?.city).toBe('Remote - EMEA');
      expect(sre?.isRemote).toBe(true);
      // D-11 application lock — single-leading-pad form (FIRST
      // cohort observation of D-11 with leading-pad): the emitted
      // `department` for the second listing equals the trimmed
      // form `'IT'` (no leading pad bytes) AND is byte-distinct
      // from the wire form `' IT'` (with one leading pad byte)
      // AND is exactly 1 byte shorter AND does NOT start with a
      // leading ASCII space. **Third cohort plugin to apply D-11**
      // (after Lattice's Spec-074 trailing-pad and Stitch Fix's
      // Spec-077 trailing-pad); **first** cohort plugin to apply
      // D-11 with a **leading-pad** form.
      expect(sre?.department).toBe('IT');
      expect(sre?.department).not.toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe(' IT');
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name.startsWith(' ')).toBe(true);
      expect(sre?.department?.startsWith(' ')).toBe(false);
      expect(sre?.department?.length).toBe(
        JOBS_PAGE_RAW.jobs[1].departments[0].name.length - 1,
      );
      // Variant-2 lock for the second listing too.
      expect(sre?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/datacamp/jobs/7531007',
      );
      expect(sre?.jobUrl).toContain('job-boards.greenhouse.io/datacamp/jobs/');
      expect(sre?.jobUrl).not.toContain('/?gh_jid=');
      expect(sre?.jobUrl).not.toContain('datacamp.com/careers/');
      // Tags stripped after decode.
      expect(sre?.description).not.toContain('<p>');
      expect(sre?.description).not.toContain('<strong>');
      expect(sre?.description).toContain('DataCamp-for-Business');
      expect(sre?.description).toContain('DataCamp');

      // Regression guard: the slug must be `datacamp` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/datacamp/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatacampService();
      const input: ScraperInputDto = {
        siteType: [Site.DATACAMP],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatacampService();
      const result = await service.scrape({
        siteType: [Site.DATACAMP],
        searchTerm: 'CURRICULUM',
      } as ScraperInputDto);

      // Only the first fixture job has 'Curriculum' in its title;
      // case-insensitive `'CURRICULUM'` matches it byte-for-byte.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('datacamp-7067243');
    });

    it('filters by case-insensitive substring of department name (against trimmed form — D-11 leading-pad search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DatacampService();
      const result = await service.scrape({
        siteType: [Site.DATACAMP],
        searchTerm: 'it',
      } as ScraperInputDto);

      // Only the second fixture job has the `'IT'` department
      // (after trimming the wire `' IT'`). The first listing's
      // department `'Learner Product'` does NOT contain `'it'`
      // case-insensitively as a substring (no `it` letter pair),
      // so it filters out. The second listing's TRIMMED department
      // `'IT'` matches `'it'` case-insensitively (D-11 leading-pad
      // search guard locks: the search must hit the trimmed form,
      // NOT the wire `' IT'` — without the trim before searchTerm,
      // the case-insensitive contains-match would still hit, so
      // this assertion is more of a no-regression invariant on
      // the application order than a behaviour-distinguishing
      // assertion).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('datacamp-7531007');
      expect(result.jobs[0].department).toBe('IT');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DatacampService();
      const result = await service.scrape({
        siteType: [Site.DATACAMP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DatacampService();
      const result = await service.scrape({
        siteType: [Site.DATACAMP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
