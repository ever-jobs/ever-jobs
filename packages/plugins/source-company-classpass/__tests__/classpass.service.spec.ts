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

import { ClasspassModule, ClasspassService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'classpass-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 067 / T04 — `ClasspassService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ClasspassService` through `ClasspassModule`.
 *   2. `Site.CLASSPASS === 'classpass'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `classpass`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-12 vanity-domain
 *      `playlist.com/careers/opportunities/<id>?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04 — first
 *      plugin in the cohort to use variant 12), (d) the emitted
 *      `companyName` is the single-token bare-brand display
 *      `'ClassPass'` byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      for the SECOND listing is the trimmed form `'Director,
 *      Product Management, ClassPass Consumer'` AND is byte-distinct
 *      from the wire form `'Director, Product Management, ClassPass
 *      Consumer '` (D-10 application lock — `.trim()` observable),
 *      (f) the emitted `department` for the FIRST listing matches
 *      the wire `departments[0].name` byte-for-byte (`'Sales'` —
 *      clean single-token form, D-11 pass-through), and (g) the
 *      emitted `department` for the SECOND listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Marketing'` — clean
 *      single-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ClasspassService — Spec 067 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ClasspassModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ClasspassModule],
      }).compile();
      const service = moduleRef.get(ClasspassService);
      expect(service).toBeInstanceOf(ClasspassService);
      await moduleRef.close();
    });

    it('exports the Site.CLASSPASS = "classpass" enum value', () => {
      expect(Site.CLASSPASS).toBe('classpass');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ClasspassService();
      const input: ScraperInputDto = {
        siteType: [Site.CLASSPASS],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const am = dto.jobs.find((j) => j.id === 'classpass-4662072006');
      expect(am).toBeDefined();
      expect(am?.site).toBe(Site.CLASSPASS);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand display `'ClassPass'` byte-for-byte
      // AND matches the wire `company_name` byte-for-byte.
      // Seventeenth cohort plugin to omit D-09.
      expect(am?.companyName).toBe('ClassPass');
      expect(am?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(am?.title).toBe('Account Manager');
      expect(am?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: ClassPass's tenant publishes `absolute_url` on
      // the previously-unobserved variant-12 vanity-domain shape
      // `https://www.playlist.com/careers/opportunities/<id>?gh_jid=<id>`.
      // The plugin emits `listing.absolute_url` byte-for-byte.
      // First plugin in the cohort to use variant 12 — fifteenth
      // distinct wire-shape variant.
      expect(am?.jobUrl).toBe(
        'https://www.playlist.com/careers/opportunities/4662072006?gh_jid=4662072006',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `playlist.com/careers/opportunities/` substring (variant-12
      // vanity-domain path) AND the literal `?gh_jid=` query
      // parameter (single-`gh_jid`, distinct from Elastic's variant-11
      // duplicate-`gh_jid` shape) AND must NOT contain
      // `job-boards.greenhouse.io` (locking the variant-12 shape
      // against future refactors that might naively normalise to
      // variant 2).
      expect(am?.jobUrl).toContain('playlist.com/careers/opportunities/');
      expect(am?.jobUrl).toContain('?gh_jid=');
      expect(am?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(am?.location?.city).toBe('New York, NY');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Sales'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity to
      // the wire shape).
      expect(am?.department).toBe('Sales');
      expect(am?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(am?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&amp;` (ampersand entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(am?.description).not.toContain('&lt;');
      expect(am?.description).not.toContain('&quot;');
      expect(am?.description).not.toContain('&amp;');
      expect(am?.description).not.toContain('<p>');
      expect(am?.description).not.toContain('<div>');
      expect(am?.description).not.toContain('<strong>');
      expect(am?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(am?.description).toContain('ClassPass');
      expect(am?.description).toContain('subscription-fitness');

      const dpm = dto.jobs.find((j) => j.id === 'classpass-4674582006');
      expect(dpm).toBeDefined();
      // D-10 application lock: the emitted `title` for the second
      // listing equals the trimmed form `'Director, Product
      // Management, ClassPass Consumer'` (no trailing pad byte) AND
      // is byte-distinct from the wire form `'Director, Product
      // Management, ClassPass Consumer '` (with trailing pad byte).
      // Locking the D-10 application against a future refactor that
      // drops the `.trim()` and reintroduces the wire pad byte.
      // Tenth cohort plugin to apply D-10.
      expect(dpm?.title).toBe('Director, Product Management, ClassPass Consumer');
      expect(dpm?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Director, Product Management, ClassPass Consumer ',
      );
      // The wire title closes with a trailing pad byte; the emitted
      // title closes with the alphabetic byte 'r'.
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(dpm?.title.endsWith(' ')).toBe(false);
      expect(dpm?.companyName).toBe('ClassPass');
      expect(dpm?.location?.city).toBe('San Francisco, CA');
      expect(dpm?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Marketing'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity).
      expect(dpm?.department).toBe('Marketing');
      expect(dpm?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-12 lock for the second listing too.
      expect(dpm?.jobUrl).toBe(
        'https://www.playlist.com/careers/opportunities/4674582006?gh_jid=4674582006',
      );
      expect(dpm?.jobUrl).toContain('playlist.com/careers/opportunities/');
      expect(dpm?.jobUrl).toContain('?gh_jid=');
      expect(dpm?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(dpm?.description).not.toContain('<p>');
      expect(dpm?.description).not.toContain('<h2>');
      expect(dpm?.description).toContain('Director, Product Management');
      expect(dpm?.description).toContain('Consumer');

      // Regression guard: the slug must be `classpass` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/classpass/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ClasspassService();
      const input: ScraperInputDto = {
        siteType: [Site.CLASSPASS],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ClasspassService();
      const result = await service.scrape({
        siteType: [Site.CLASSPASS],
        searchTerm: 'PRODUCT MANAGEMENT',
      } as ScraperInputDto);

      // Only the second fixture job has 'Product Management' in its
      // title (`'Director, Product Management, ClassPass Consumer'`
      // after trim); the case-insensitive match on the literal
      // `'PRODUCT MANAGEMENT'` substring matches the trimmed second
      // listing's title byte-for-byte. The first listing's title
      // ('Account Manager') and dept ('Sales') do not contain
      // 'product management', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('classpass-4674582006');
      // Lock the D-10 application observable — the emitted title for
      // the matched listing carries the trimmed form (no pad byte).
      expect(result.jobs[0].title).toBe(
        'Director, Product Management, ClassPass Consumer',
      );
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ClasspassService();
      const result = await service.scrape({
        siteType: [Site.CLASSPASS],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      // Only the second fixture job has `'Marketing'` as its
      // department; the case-insensitive match on the literal
      // `'marketing'` substring matches the literal `'Marketing'`
      // department name. The first listing's title-search miss
      // ('Account Manager' does not contain 'marketing') and dept
      // miss ('Sales' does not contain 'marketing') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('classpass-4674582006');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ClasspassService();
      const result = await service.scrape({
        siteType: [Site.CLASSPASS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ClasspassService();
      const result = await service.scrape({
        siteType: [Site.CLASSPASS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
