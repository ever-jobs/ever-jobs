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

import { StitchfixModule, StitchfixService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'stitchfix-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 077 / T04 — `StitchfixService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `StitchfixService` through `StitchfixModule`.
 *   2. `Site.STITCHFIX === 'stitchfix'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `stitchfix`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-16 bare-www brand-domain
 *      `www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte INCLUDING the
 *      duplicate `gh_jid` query parameter (D-04 — first plugin in
 *      the cohort to use variant 16, the **nineteenth distinct
 *      wire-shape variant** in the company-direct cohort), (d) the
 *      emitted `companyName` is the internal-whitespace-asymmetric
 *      wire `'Stitch Fix'` byte-for-byte AND matches the wire
 *      `company_name` byte-for-byte AND is byte-distinct from the
 *      slug `stitchfix` AND is exactly **1 byte longer** than the
 *      slug (locking the slug/wire internal-whitespace asymmetry —
 *      D-09 omission lock, the **third** cohort case where wire
 *      and slug differ by an internal whitespace byte after Scale
 *      AI and Maven Clinic; same +1 byte differential, same
 *      single-internal-space delta), (e) **D-10 trim lock** — the
 *      emitted `title` for the SECOND listing equals trimmed form
 *      `'Principal Full-Stack Data Scientist - Recommendation
 *      Algorithms'` AND is byte-distinct from wire-padded form
 *      `'Principal Full-Stack Data Scientist - Recommendation
 *      Algorithms '` AND is exactly **1 byte shorter** (locking
 *      the single-trailing-pad form), (f) the emitted `department`
 *      for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Engineering'` —
 *      clean single-token form, D-11 pass-through), and (g) the
 *      emitted `department` for the SECOND listing matches the
 *      wire `departments[0].name` byte-for-byte (`'Data Platform'`
 *      — clean multi-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('StitchfixService — Spec 077 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through StitchfixModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StitchfixModule],
      }).compile();
      const service = moduleRef.get(StitchfixService);
      expect(service).toBeInstanceOf(StitchfixService);
      await moduleRef.close();
    });

    it('exports the Site.STITCHFIX = "stitchfix" enum value', () => {
      expect(Site.STITCHFIX).toBe('stitchfix');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StitchfixService();
      const input: ScraperInputDto = {
        siteType: [Site.STITCHFIX],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const algos = dto.jobs.find((j) => j.id === 'stitchfix-7624583');
      expect(algos).toBeDefined();
      expect(algos?.site).toBe(Site.STITCHFIX);
      // D-09 omission lock with internal-whitespace wire variant: the
      // emitted `companyName` is the two-word `'Stitch Fix'` byte-
      // for-byte AND matches the wire `company_name` byte-for-byte
      // AND is byte-distinct from the lowercase concatenated slug
      // `stitchfix` AND is exactly 1 byte longer than the slug
      // (locking the internal-whitespace asymmetry — third cohort
      // observation of this asymmetry shape after Scale AI and
      // Maven Clinic). Twenty-seventh cohort plugin to omit D-09.
      expect(algos?.companyName).toBe('Stitch Fix');
      expect(algos?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(algos?.companyName).not.toBe('stitchfix');
      expect(algos?.companyName!.length).toBe('stitchfix'.length + 1);
      // Case-insensitively-with-space-collapsed equality lock — the
      // emitted `companyName` collapses to the lowercase slug when
      // the internal space is removed. This guards against future
      // wire-side normalisation that drops the space (which would
      // make the wire equal-byte-length to the slug — case-only
      // asymmetry like MasterClass).
      expect(algos?.companyName?.toLowerCase().replace(/\s+/g, '')).toBe('stitchfix');
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(algos?.title).toBe('Senior Software Engineer, Algorithms');
      expect(algos?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Stitch Fix's tenant publishes `absolute_url` on
      // wire-shape variant 16 — the bare-www brand-domain
      // `https://www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
      // shape with the duplicate `gh_jid` query parameter. The
      // plugin emits `listing.absolute_url` byte-for-byte. First
      // plugin in the cohort to use variant 16 — the nineteenth
      // distinct wire-shape variant in the company-direct cohort.
      expect(algos?.jobUrl).toBe(
        'https://www.stitchfix.com/careers/jobs?gh_jid=7624583&gh_jid=7624583',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `www.stitchfix.com/careers/jobs?gh_jid=` substring (variant-
      // 16 bare-www brand-domain) AND must contain a SECOND
      // `&gh_jid=` (locking the duplicate-query variant-16 shape
      // against future refactors that might naively normalise to
      // single-query variant 13 / 15).
      expect(algos?.jobUrl).toContain('www.stitchfix.com/careers/jobs?gh_jid=');
      expect(algos?.jobUrl).toContain('&gh_jid=');
      expect(algos?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // The duplicate-query parameter MUST appear exactly twice in
      // the URL (the most distinctive feature of variant 16).
      const occurrences = (algos!.jobUrl!.match(/gh_jid=/g) ?? []).length;
      expect(occurrences).toBe(2);
      // Location — Stitch Fix's SF HQ on the first listing.
      expect(algos?.location?.city).toBe('San Francisco, CA');
      expect(algos?.isRemote).toBe(false);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Engineering'` byte-for-byte
      // (clean single-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(algos?.department).toBe('Engineering');
      expect(algos?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&quot;` (named entities not decoded), `&amp;` (ampersand
      // entities not decoded), or literal `<p>`/`<div>`/`<strong>`/
      // `<em>` (tags not stripped after decode).
      expect(algos?.description).not.toContain('&lt;');
      expect(algos?.description).not.toContain('&quot;');
      expect(algos?.description).not.toContain('&amp;');
      expect(algos?.description).not.toContain('<p>');
      expect(algos?.description).not.toContain('<div>');
      expect(algos?.description).not.toContain('<strong>');
      expect(algos?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(algos?.description).toContain('Stitch Fix');
      expect(algos?.description).toContain('recommendation');

      const principal = dto.jobs.find((j) => j.id === 'stitchfix-7778233');
      expect(principal).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Principal Full-Stack Data Scientist - Recommendation
      // Algorithms'` (no trailing pad bytes) AND is byte-distinct
      // from the wire form `'Principal Full-Stack Data Scientist -
      // Recommendation Algorithms '` (with one trailing pad byte)
      // AND is exactly 1 byte shorter. Sixteenth cohort plugin to
      // apply D-10.
      expect(principal?.title).toBe(
        'Principal Full-Stack Data Scientist - Recommendation Algorithms',
      );
      expect(principal?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Principal Full-Stack Data Scientist - Recommendation Algorithms ',
      );
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(principal?.title.endsWith(' ')).toBe(false);
      expect(principal?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(principal?.companyName).toBe('Stitch Fix');
      expect(principal?.location?.city).toBe('Remote, USA');
      expect(principal?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Data Platform'` byte-for-
      // byte (clean multi-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(principal?.department).toBe('Data Platform');
      expect(principal?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-16 lock for the second listing too.
      expect(principal?.jobUrl).toBe(
        'https://www.stitchfix.com/careers/jobs?gh_jid=7778233&gh_jid=7778233',
      );
      expect(principal?.jobUrl).toContain('www.stitchfix.com/careers/jobs?gh_jid=');
      expect(principal?.jobUrl).toContain('&gh_jid=');
      const occurrences2 = (principal!.jobUrl!.match(/gh_jid=/g) ?? []).length;
      expect(occurrences2).toBe(2);
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(principal?.description).not.toContain('<p>');
      expect(principal?.description).not.toContain('<strong>');
      expect(principal?.description).toContain('Data Platform');
      expect(principal?.description).toContain('Stitch Fix');

      // Regression guard: the slug must be `stitchfix` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/stitchfix/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StitchfixService();
      const input: ScraperInputDto = {
        siteType: [Site.STITCHFIX],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StitchfixService();
      const result = await service.scrape({
        siteType: [Site.STITCHFIX],
        searchTerm: 'PRINCIPAL',
      } as ScraperInputDto);

      // Only the second fixture job has 'Principal' in its title
      // (trimmed `'Principal Full-Stack Data Scientist -
      // Recommendation Algorithms'`); the case-insensitive match
      // on the literal `'PRINCIPAL'` substring matches the trimmed
      // second listing's title byte-for-byte. The first listing's
      // title ('Senior Software Engineer, Algorithms') and dept
      // ('Engineering') do not contain 'principal', so it filters
      // out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('stitchfix-7778233');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe(
        'Principal Full-Stack Data Scientist - Recommendation Algorithms',
      );
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StitchfixService();
      const result = await service.scrape({
        siteType: [Site.STITCHFIX],
        searchTerm: 'data platform',
      } as ScraperInputDto);

      // Only the second fixture job has `'Data Platform'` as its
      // department (the first listing's title 'Senior Software
      // Engineer, Algorithms' and dept 'Engineering' do not
      // contain 'data platform', so it filters out).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('stitchfix-7778233');
      expect(result.jobs[0].department).toBe('Data Platform');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new StitchfixService();
      const result = await service.scrape({
        siteType: [Site.STITCHFIX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new StitchfixService();
      const result = await service.scrape({
        siteType: [Site.STITCHFIX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
