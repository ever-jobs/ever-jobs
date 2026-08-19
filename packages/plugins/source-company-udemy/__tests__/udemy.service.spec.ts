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

import { UdemyModule, UdemyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'udemy-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 078 / T04 — `UdemyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `UdemyService` through `UdemyModule`.
 *   2. `Site.UDEMY === 'udemy'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `udemy`, (b) the description has named entities
 *      (`&quot;`), numeric entities (`&#39;`), AND tags stripped
 *      (D-08), (c) the variant-17 third-party-SaaS-host
 *      `app.careerpuck.com/job-board/udemy/job/<id>?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04 — first
 *      plugin in the cohort to use variant 17, the **twentieth
 *      distinct wire-shape variant** in the company-direct cohort,
 *      and the **first** to publish through a third-party SaaS
 *      career-board host (CareerPuck) rather than a brand-owned
 *      domain or a Greenhouse-owned host), (d) the emitted
 *      `companyName` is the case-symmetric wire `'Udemy'` byte-for-
 *      byte AND matches the wire `company_name` byte-for-byte AND
 *      is case-insensitively-equal to the slug `udemy`, (e)
 *      **D-10 trim lock** — the emitted `title` for the SECOND
 *      listing equals trimmed form `'Sales Development
 *      Representative'` AND is byte-distinct from wire-padded
 *      form `'Sales Development Representative '` AND is exactly
 *      **1 byte shorter** (locking the single-trailing-pad form),
 *      (f) the emitted `department` for the FIRST listing matches
 *      the wire `departments[0].name` byte-for-byte
 *      (`'Engineering'` — clean single-token form, D-11 pass-
 *      through), and (g) the emitted `department` for the SECOND
 *      listing matches the wire `departments[0].name` byte-for-
 *      byte (`'UB Sales - SDR'` — clean multi-token form with
 *      internal whitespace and hyphens, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('UdemyService — Spec 078 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through UdemyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [UdemyModule],
      }).compile();
      const service = moduleRef.get(UdemyService);
      expect(service).toBeInstanceOf(UdemyService);
      await moduleRef.close();
    });

    it('exports the Site.UDEMY = "udemy" enum value', () => {
      expect(Site.UDEMY).toBe('udemy');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new UdemyService();
      const input: ScraperInputDto = {
        siteType: [Site.UDEMY],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const backend = dto.jobs.find((j) => j.id === 'udemy-5424719004');
      expect(backend).toBeDefined();
      expect(backend?.site).toBe(Site.UDEMY);
      // D-09 omission lock with case-symmetric wire variant: the
      // emitted `companyName` is the bare-brand `'Udemy'` byte-
      // for-byte AND matches the wire `company_name` byte-for-byte
      // AND is case-insensitively-equal to the lowercase slug
      // `udemy`. Twenty-eighth cohort plugin to omit D-09.
      expect(backend?.companyName).toBe('Udemy');
      expect(backend?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(backend?.companyName?.toLowerCase()).toBe('udemy');
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(backend?.title).toBe('Senior Backend Engineer');
      expect(backend?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Udemy's tenant publishes `absolute_url` on
      // wire-shape variant 17 — the third-party-SaaS-host
      // `https://app.careerpuck.com/job-board/udemy/job/<id>?gh_jid=<id>`
      // shape with the CareerPuck SaaS host. The plugin emits
      // `listing.absolute_url` byte-for-byte. First plugin in
      // the cohort to use variant 17 — the twentieth distinct
      // wire-shape variant in the company-direct cohort and
      // the first to publish through a third-party SaaS career-
      // board host.
      expect(backend?.jobUrl).toBe(
        'https://app.careerpuck.com/job-board/udemy/job/5424719004?gh_jid=5424719004',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `app.careerpuck.com/job-board/udemy/job/` substring
      // (variant-17 third-party-SaaS-host) AND must NOT contain
      // `job-boards.greenhouse.io` (locking the variant-17 shape
      // against future refactors that might naively normalise to
      // variant 2).
      expect(backend?.jobUrl).toContain('app.careerpuck.com/job-board/udemy/job/');
      expect(backend?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Location — Udemy's SF HQ on the first listing.
      expect(backend?.location?.city).toBe('San Francisco, CA');
      expect(backend?.isRemote).toBe(false);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Engineering'` byte-for-byte
      // (clean single-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(backend?.department).toBe('Engineering');
      expect(backend?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&quot;` (named entities not decoded), `&amp;` (ampersand
      // entities not decoded), or literal `<p>`/`<div>`/`<strong>`/
      // `<em>` (tags not stripped after decode).
      expect(backend?.description).not.toContain('&lt;');
      expect(backend?.description).not.toContain('&quot;');
      expect(backend?.description).not.toContain('&amp;');
      expect(backend?.description).not.toContain('<p>');
      expect(backend?.description).not.toContain('<div>');
      expect(backend?.description).not.toContain('<strong>');
      expect(backend?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(backend?.description).toContain('Udemy');
      expect(backend?.description).toContain('marketplace');

      const sdr = dto.jobs.find((j) => j.id === 'udemy-5465494004');
      expect(sdr).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Sales Development Representative'` (no trailing pad
      // bytes) AND is byte-distinct from the wire form `'Sales
      // Development Representative '` (with one trailing pad byte)
      // AND is exactly 1 byte shorter. Seventeenth cohort plugin
      // to apply D-10.
      expect(sdr?.title).toBe('Sales Development Representative');
      expect(sdr?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Sales Development Representative ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(sdr?.title.endsWith(' ')).toBe(false);
      expect(sdr?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(sdr?.companyName).toBe('Udemy');
      expect(sdr?.location?.city).toBe('Remote, USA');
      expect(sdr?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'UB Sales - SDR'` byte-for-
      // byte (clean multi-token form with internal whitespace and
      // hyphens; pass-through preserves byte-fidelity to the wire
      // shape).
      expect(sdr?.department).toBe('UB Sales - SDR');
      expect(sdr?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-17 lock for the second listing too.
      expect(sdr?.jobUrl).toBe(
        'https://app.careerpuck.com/job-board/udemy/job/5465494004?gh_jid=5465494004',
      );
      expect(sdr?.jobUrl).toContain('app.careerpuck.com/job-board/udemy/job/');
      expect(sdr?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(sdr?.description).not.toContain('<p>');
      expect(sdr?.description).not.toContain('<strong>');
      expect(sdr?.description).toContain('Udemy Business');
      expect(sdr?.description).toContain('Sales Development Representative');

      // Regression guard: the slug must be `udemy` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/udemy/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new UdemyService();
      const input: ScraperInputDto = {
        siteType: [Site.UDEMY],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new UdemyService();
      const result = await service.scrape({
        siteType: [Site.UDEMY],
        searchTerm: 'REPRESENTATIVE',
      } as ScraperInputDto);

      // Only the second fixture job has 'Representative' in its
      // title (trimmed `'Sales Development Representative'`); the
      // case-insensitive match on `'REPRESENTATIVE'` matches the
      // trimmed second listing's title byte-for-byte. The first
      // listing's title ('Senior Backend Engineer') and dept
      // ('Engineering') do not contain 'representative', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('udemy-5465494004');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('Sales Development Representative');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new UdemyService();
      const result = await service.scrape({
        siteType: [Site.UDEMY],
        searchTerm: 'ub sales',
      } as ScraperInputDto);

      // Only the second fixture job has `'UB Sales - SDR'` as its
      // department (the first listing's title 'Senior Backend
      // Engineer' and dept 'Engineering' do not contain 'ub
      // sales', so it filters out).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('udemy-5465494004');
      expect(result.jobs[0].department).toBe('UB Sales - SDR');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new UdemyService();
      const result = await service.scrape({
        siteType: [Site.UDEMY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new UdemyService();
      const result = await service.scrape({
        siteType: [Site.UDEMY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
