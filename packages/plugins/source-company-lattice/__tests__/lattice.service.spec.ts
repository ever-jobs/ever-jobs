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

import { LatticeModule, LatticeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'lattice-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 074 / T04 — `LatticeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `LatticeService` through `LatticeModule`.
 *   2. `Site.LATTICE === 'lattice'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `lattice`, (b) the description has named
 *      entities (`&amp;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-15 bare brand-domain
 *      `lattice.com/job?gh_jid=<id>` `absolute_url` flows through
 *      byte-for-byte (D-04 — first plugin in the cohort to use
 *      variant 15), (d) the emitted `companyName` is the
 *      slug-symmetric wire `'Lattice'` byte-for-byte AND matches
 *      the wire `company_name` byte-for-byte AND case-insensitively
 *      equal to the slug `lattice` (locking the slug-symmetric wire
 *      observable — D-09 omission lock with case-symmetric wire
 *      variant), (e) **D-10 omission lock** — the emitted `title`
 *      for both listings equals the wire `title` byte-for-byte (no
 *      trim applied; pass-through observable since wire is fully
 *      clean), (f) the emitted `department` for the FIRST listing
 *      matches the wire `departments[0].name` byte-for-byte
 *      (`'Account Executive'` — clean form; trim is a no-op), and
 *      (g) **D-11 application lock** — the emitted `department`
 *      for the SECOND listing equals trimmed form `'Product'` AND
 *      is byte-distinct from wire-padded form `'Product '` AND is
 *      exactly **1 byte shorter** (locking the first-ever cohort
 *      D-11 application).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive against the trimmed form — D-11 search guard).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('LatticeService — Spec 074 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through LatticeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [LatticeModule],
      }).compile();
      const service = moduleRef.get(LatticeService);
      expect(service).toBeInstanceOf(LatticeService);
      await moduleRef.close();
    });

    it('exports the Site.LATTICE = "lattice" enum value', () => {
      expect(Site.LATTICE).toBe('lattice');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LatticeService();
      const input: ScraperInputDto = {
        siteType: [Site.LATTICE],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'lattice-8483245002');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.LATTICE);
      // D-09 omission lock: the emitted `companyName` is the
      // slug-symmetric `'Lattice'` byte-for-byte AND matches the
      // wire `company_name` byte-for-byte AND case-insensitively
      // equals the slug `lattice` (locking the slug-symmetric
      // wire observable). Twenty-fourth cohort plugin to omit D-09.
      expect(ae?.companyName).toBe('Lattice');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ae?.companyName?.toLowerCase()).toBe('lattice');
      // D-10 omission lock: emitted `title` matches the wire
      // `title` byte-for-byte (no trim; pass-through observable).
      // Eleventh cohort plugin to omit D-10.
      expect(ae?.title).toBe('Account Executive, Mid-Market');
      expect(ae?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Lattice's tenant publishes `absolute_url` on
      // wire-shape variant 15 — the bare brand-domain
      // `https://lattice.com/job?gh_jid=<id>` shape. The plugin
      // emits `listing.absolute_url` byte-for-byte. First plugin
      // in the cohort to use variant 15.
      expect(ae?.jobUrl).toBe(
        'https://lattice.com/job?gh_jid=8483245002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `lattice.com/job?gh_jid=` substring (variant-15 bare-domain
      // shape) AND must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-15 shape against future refactors that
      // might naively normalise to variant 2).
      expect(ae?.jobUrl).toContain('lattice.com/job?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Location — Lattice wire is fully clean on the location axis
      // (D-12 not applied). Remote-detection picks up the literal
      // `Remote` substring case-insensitively.
      expect(ae?.location?.city).toBe('Remote-US, PST or EST');
      expect(ae?.isRemote).toBe(true);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Account Executive'` byte-for-byte
      // (clean single-token form; trim is a no-op on the clean
      // wire data).
      expect(ae?.department).toBe('Account Executive');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&amp;` (ampersand entities not decoded), or literal
      // `<p>`/`<h2>`/`<div>`/`<strong>` (tags not stripped after
      // decode).
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<h2>');
      expect(ae?.description).not.toContain('<div>');
      expect(ae?.description).not.toContain('<strong>');
      // Sanity: the role-specific body content survives the strip.
      expect(ae?.description).toContain('Lattice');
      expect(ae?.description).toContain('Account Executive');

      const spm = dto.jobs.find((j) => j.id === 'lattice-8523623002');
      expect(spm).toBeDefined();
      // D-10 omission lock: second listing title also passes through
      // byte-for-byte — wire is clean.
      expect(spm?.title).toBe('Staff Product Manager, AI');
      expect(spm?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(spm?.companyName).toBe('Lattice');
      expect(spm?.location?.city).toBe('Remote - Canada');
      expect(spm?.isRemote).toBe(true);
      // D-11 application lock — single-trailing-pad form: the
      // emitted `department` for the second listing equals the
      // trimmed form `'Product'` (no trailing pad bytes) AND is
      // byte-distinct from the wire form `'Product '` (with one
      // trailing pad byte) AND is exactly 1 byte shorter. First
      // cohort plugin to apply D-11.
      expect(spm?.department).toBe('Product');
      expect(spm?.department).not.toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Product ');
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name.endsWith(' ')).toBe(true);
      expect(spm?.department?.endsWith(' ')).toBe(false);
      expect(spm?.department?.length).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name.length - 1);
      // Variant-15 lock for the second listing too.
      expect(spm?.jobUrl).toBe(
        'https://lattice.com/job?gh_jid=8523623002',
      );
      expect(spm?.jobUrl).toContain('lattice.com/job?gh_jid=');
      expect(spm?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(spm?.description).not.toContain('<p>');
      expect(spm?.description).not.toContain('<strong>');
      expect(spm?.description).toContain('Product Manager');
      expect(spm?.description).toContain('AI');

      // Regression guard: the slug must be `lattice` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/lattice/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LatticeService();
      const input: ScraperInputDto = {
        siteType: [Site.LATTICE],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LatticeService();
      const result = await service.scrape({
        siteType: [Site.LATTICE],
        searchTerm: 'MID-MARKET',
      } as ScraperInputDto);

      // Only the first fixture job has 'Mid-Market' in its title;
      // the case-insensitive match on the literal `'MID-MARKET'`
      // substring matches the first listing's title byte-for-byte.
      // The second listing's title ('Staff Product Manager, AI')
      // and dept ('Product' trimmed) do not contain 'mid-market',
      // so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('lattice-8483245002');
      // Lock the D-10 omission observable — the emitted title for
      // the matched listing matches the wire byte-for-byte.
      expect(result.jobs[0].title).toBe('Account Executive, Mid-Market');
    });

    it('filters by case-insensitive substring of department name (D-11 search guard — match is on trimmed form)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LatticeService();
      const result = await service.scrape({
        siteType: [Site.LATTICE],
        searchTerm: 'product',
      } as ScraperInputDto);

      // Only the second fixture job has `'Product'` as its
      // department (trimmed from wire-padded `'Product '`); the
      // case-insensitive match on the literal `'product'` substring
      // matches the trimmed `'Product'` department name. The first
      // listing's title ('Account Executive, Mid-Market') and dept
      // ('Account Executive') do not contain 'product', so it
      // filters out. D-11 search guard: the search runs against the
      // trimmed department form, so a literal `'Product '` (with
      // pad bytes) substring search would still match because the
      // search uses `.includes` against the trimmed form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('lattice-8523623002');
      expect(result.jobs[0].department).toBe('Product');
      expect(result.jobs[0].department?.endsWith(' ')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new LatticeService();
      const result = await service.scrape({
        siteType: [Site.LATTICE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new LatticeService();
      const result = await service.scrape({
        siteType: [Site.LATTICE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
