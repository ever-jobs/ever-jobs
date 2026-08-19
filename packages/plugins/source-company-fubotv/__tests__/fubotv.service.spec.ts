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

import { FubotvModule, FubotvService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'fubotv-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 071 / T04 — `FubotvService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FubotvService` through `FubotvModule`.
 *   2. `Site.FUBOTV === 'fubotv'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `fubotv`, (b) the description has named entities
 *      (`&quot;`), numeric entities (`&#39;`), AND tags stripped (D-08),
 *      (c) the variant-14 vanity-domain
 *      `careers.fubo.tv/fubotv-job-openings/?gh_jid=<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — first plugin in the cohort
 *      to use variant 14), (d) the emitted `companyName` is the
 *      slug/wire-asymmetric single-token bare-brand `'Fubo'`
 *      byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      for the SECOND listing equals trimmed form `'Senior Software
 *      Engineer, Backend'` AND is byte-distinct from wire-padded form
 *      `'Senior Software Engineer, Backend '` AND is exactly 1 byte
 *      shorter (D-10 application lock), (f) the emitted `department`
 *      for the FIRST listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Business Development'` — clean multi-token
 *      form, D-11 pass-through), (g) the emitted `department` for
 *      the SECOND listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Technology'` — clean single-token form, D-11
 *      pass-through), and (h) **D-12 application lock** — emitted
 *      `location.city` for the first listing equals trimmed
 *      `'New York, NY'` AND is byte-distinct from wire-padded
 *      `'New York, NY '` AND is exactly 1 byte shorter; second
 *      listing's `'Denver, CO'` vs. wire-padded `'Denver, CO '`.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('FubotvService — Spec 071 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FubotvModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FubotvModule],
      }).compile();
      const service = moduleRef.get(FubotvService);
      expect(service).toBeInstanceOf(FubotvService);
      await moduleRef.close();
    });

    it('exports the Site.FUBOTV = "fubotv" enum value', () => {
      expect(Site.FUBOTV).toBe('fubotv');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FubotvService();
      const input: ScraperInputDto = {
        siteType: [Site.FUBOTV],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const mbd = dto.jobs.find((j) => j.id === 'fubotv-7717998');
      expect(mbd).toBeDefined();
      expect(mbd?.site).toBe(Site.FUBOTV);
      // D-09 omission lock: the emitted `companyName` is the
      // slug/wire-asymmetric single-token bare-brand `'Fubo'`
      // byte-for-byte AND matches the wire `company_name`
      // byte-for-byte. Twenty-first cohort plugin to omit D-09.
      // **Slug/wire asymmetry lock**: the emitted `companyName ===
      // 'Fubo'` (4 bytes) is byte-distinct from the slug `fubotv`
      // (6 bytes) — the third asymmetry case in the cohort and
      // the first where the wire is shorter than the slug.
      expect(mbd?.companyName).toBe('Fubo');
      expect(mbd?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect((mbd?.companyName ?? '').length).toBeLessThan('fubotv'.length);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(mbd?.title).toBe('Manager, Business Development - Platform Partnerships');
      expect(mbd?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: fuboTV's tenant publishes `absolute_url` on
      // wire-shape variant 14 — the previously-unobserved
      // vanity-domain fixed-path query-only-id shape
      // `https://careers.fubo.tv/fubotv-job-openings/?gh_jid=<id>`
      // (the listing ID appears ONLY in the query parameter, not
      // in the path). The plugin emits `listing.absolute_url`
      // byte-for-byte. First plugin in the cohort to use variant
      // 14 — seventeenth distinct wire-shape variant.
      expect(mbd?.jobUrl).toBe(
        'https://careers.fubo.tv/fubotv-job-openings/?gh_jid=7717998',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `careers.fubo.tv/fubotv-job-openings/` substring (variant-14
      // vanity-domain fixed-path) AND the literal `?gh_jid=` query
      // parameter AND must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-14 shape against future refactors that
      // might naively normalise to variant 2).
      expect(mbd?.jobUrl).toContain('careers.fubo.tv/fubotv-job-openings/');
      expect(mbd?.jobUrl).toContain('?gh_jid=');
      expect(mbd?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // D-12 application lock: emitted `location.city` for the first
      // listing equals trimmed `'New York, NY'` (no trailing pad
      // byte) AND is byte-distinct from wire-padded
      // `'New York, NY '` AND is exactly 1 byte shorter. Locking
      // the D-12 application against a future refactor that drops
      // the location-side `.trim()`. **First cohort plugin to
      // apply D-12.**
      expect(mbd?.location?.city).toBe('New York, NY');
      expect(mbd?.location?.city).not.toBe(JOBS_PAGE_RAW.jobs[0].location.name);
      expect(JOBS_PAGE_RAW.jobs[0].location.name).toBe('New York, NY ');
      expect(JOBS_PAGE_RAW.jobs[0].location.name.endsWith(' ')).toBe(true);
      expect((mbd?.location?.city ?? '').endsWith(' ')).toBe(false);
      expect((mbd?.location?.city ?? '').length).toBe(
        JOBS_PAGE_RAW.jobs[0].location.name.length - 1,
      );
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Business Development'`
      // byte-for-byte (clean multi-token form; pass-through
      // preserves byte-fidelity to the wire shape).
      expect(mbd?.department).toBe('Business Development');
      expect(mbd?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(mbd?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&amp;` (ampersand entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(mbd?.description).not.toContain('&lt;');
      expect(mbd?.description).not.toContain('&quot;');
      expect(mbd?.description).not.toContain('&amp;');
      expect(mbd?.description).not.toContain('<p>');
      expect(mbd?.description).not.toContain('<div>');
      expect(mbd?.description).not.toContain('<strong>');
      expect(mbd?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(mbd?.description).toContain('Fubo');
      expect(mbd?.description).toContain('Business Development');

      const sse = dto.jobs.find((j) => j.id === 'fubotv-7793268');
      expect(sse).toBeDefined();
      // D-10 application lock: the emitted `title` for the second
      // listing equals the trimmed form `'Senior Software
      // Engineer, Backend'` (no trailing pad byte) AND is
      // byte-distinct from the wire form `'Senior Software
      // Engineer, Backend '` (with trailing pad byte) AND is
      // exactly 1 byte shorter. Locking the D-10 application
      // against a future refactor that drops the `.trim()`.
      // Thirteenth cohort plugin to apply D-10.
      expect(sse?.title).toBe('Senior Software Engineer, Backend');
      expect(sse?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Software Engineer, Backend ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(sse?.title.endsWith(' ')).toBe(false);
      expect(sse?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(sse?.companyName).toBe('Fubo');
      // D-12 second-listing application lock.
      expect(sse?.location?.city).toBe('Denver, CO');
      expect(sse?.location?.city).not.toBe(JOBS_PAGE_RAW.jobs[1].location.name);
      expect(JOBS_PAGE_RAW.jobs[1].location.name).toBe('Denver, CO ');
      expect((sse?.location?.city ?? '').endsWith(' ')).toBe(false);
      expect((sse?.location?.city ?? '').length).toBe(
        JOBS_PAGE_RAW.jobs[1].location.name.length - 1,
      );
      expect(sse?.isRemote).toBe(false);
      // D-11 second-listing regression guard.
      expect(sse?.department).toBe('Technology');
      expect(sse?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-14 lock for the second listing too.
      expect(sse?.jobUrl).toBe(
        'https://careers.fubo.tv/fubotv-job-openings/?gh_jid=7793268',
      );
      expect(sse?.jobUrl).toContain('careers.fubo.tv/fubotv-job-openings/');
      expect(sse?.jobUrl).toContain('?gh_jid=');
      expect(sse?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(sse?.description).not.toContain('<p>');
      expect(sse?.description).not.toContain('<strong>');
      expect(sse?.description).toContain('Senior Software Engineer');
      expect(sse?.description).toContain('Technology');

      // Regression guard: the slug must be `fubotv` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/fubotv/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FubotvService();
      const input: ScraperInputDto = {
        siteType: [Site.FUBOTV],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FubotvService();
      const result = await service.scrape({
        siteType: [Site.FUBOTV],
        searchTerm: 'SOFTWARE ENGINEER',
      } as ScraperInputDto);

      // Only the second fixture job has 'Software Engineer' in its
      // title (`'Senior Software Engineer, Backend'` after trim);
      // the case-insensitive match on the literal `'SOFTWARE
      // ENGINEER'` substring matches the trimmed second listing's
      // title byte-for-byte. The first listing's title ('Manager,
      // Business Development - Platform Partnerships') and dept
      // ('Business Development') do not contain 'software
      // engineer', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fubotv-7793268');
      // Lock the D-10 application observable — the emitted title for
      // the matched listing carries the trimmed form (no pad byte).
      expect(result.jobs[0].title).toBe('Senior Software Engineer, Backend');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FubotvService();
      const result = await service.scrape({
        siteType: [Site.FUBOTV],
        searchTerm: 'technology',
      } as ScraperInputDto);

      // Only the second fixture job has `'Technology'` as its
      // department; the case-insensitive match on the literal
      // `'technology'` substring matches the literal `'Technology'`
      // department name. The first listing's title ('Manager,
      // Business Development - Platform Partnerships') and dept
      // ('Business Development') do not contain 'technology', so
      // it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fubotv-7793268');
      expect(result.jobs[0].department).toBe('Technology');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FubotvService();
      const result = await service.scrape({
        siteType: [Site.FUBOTV],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FubotvService();
      const result = await service.scrape({
        siteType: [Site.FUBOTV],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
