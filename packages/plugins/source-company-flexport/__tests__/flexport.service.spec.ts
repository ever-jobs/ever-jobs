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

import { FlexportModule, FlexportService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'flexport-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 070 / T04 — `FlexportService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FlexportService` through `FlexportModule`.
 *   2. `Site.FLEXPORT === 'flexport'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `flexport`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-10 legacy hosted-board
 *      `boards.greenhouse.io/flexport/jobs/<id>?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04), (d) the
 *      emitted `companyName` is the single-token bare-brand display
 *      `'Flexport'` byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      for the SECOND listing equals trimmed form `'Country Manager,
 *      Mexico'` AND is byte-distinct from wire-padded form `'Country
 *      Manager, Mexico '` AND is exactly 1 byte shorter (D-10
 *      application lock — `.trim()` observable), (f) the emitted
 *      `department` for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Sales'` — clean
 *      single-token form, D-11 pass-through), and (g) the emitted
 *      `department` for the SECOND listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Partnerships'` —
 *      clean single-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('FlexportService — Spec 070 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FlexportModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FlexportModule],
      }).compile();
      const service = moduleRef.get(FlexportService);
      expect(service).toBeInstanceOf(FlexportService);
      await moduleRef.close();
    });

    it('exports the Site.FLEXPORT = "flexport" enum value', () => {
      expect(Site.FLEXPORT).toBe('flexport');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FlexportService();
      const input: ScraperInputDto = {
        siteType: [Site.FLEXPORT],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'flexport-7564336');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.FLEXPORT);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand display `'Flexport'` byte-for-byte
      // AND matches the wire `company_name` byte-for-byte.
      // Twentieth cohort plugin to omit D-09.
      expect(ae?.companyName).toBe('Flexport');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(ae?.title).toBe('Account Executive, ENT');
      expect(ae?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Flexport's tenant publishes `absolute_url` on
      // wire-shape variant 10 — the legacy hosted-board apex
      // `https://boards.greenhouse.io/flexport/jobs/<id>?gh_jid=<id>`
      // shape. The plugin emits `listing.absolute_url` byte-for-byte.
      // Third plugin in the cohort to use variant 10 (after Chime
      // and Faire).
      expect(ae?.jobUrl).toBe(
        'https://boards.greenhouse.io/flexport/jobs/7564336?gh_jid=7564336',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `boards.greenhouse.io/flexport/jobs/` substring (variant-10
      // legacy hosted-board host) AND the literal `?gh_jid=` query
      // parameter AND must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-10 shape against accidental drift to
      // variant 2).
      expect(ae?.jobUrl).toContain('boards.greenhouse.io/flexport/jobs/');
      expect(ae?.jobUrl).toContain('?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ae?.location?.city).toBe('Germany Remote');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Sales'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity to
      // the wire shape).
      expect(ae?.department).toBe('Sales');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // 'Germany Remote' contains 'remote' (case-insensitive).
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&amp;` (ampersand entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&quot;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<div>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(ae?.description).toContain('Flexport');
      expect(ae?.description).toContain('global trade');

      const cm = dto.jobs.find((j) => j.id === 'flexport-7651413');
      expect(cm).toBeDefined();
      // D-10 application lock: the emitted `title` for the second
      // listing equals the trimmed form `'Country Manager, Mexico'`
      // (no trailing pad byte) AND is byte-distinct from the wire
      // form `'Country Manager, Mexico '` (with trailing pad byte)
      // AND is exactly 1 byte shorter. Locking the D-10 application
      // against a future refactor that drops the `.trim()` and
      // reintroduces the wire pad byte. Twelfth cohort plugin to
      // apply D-10.
      expect(cm?.title).toBe('Country Manager, Mexico');
      expect(cm?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Country Manager, Mexico ');
      // The wire title closes with a trailing pad byte; the emitted
      // title closes with the alphabetic byte 'o'.
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(cm?.title.endsWith(' ')).toBe(false);
      // Trim is exactly 1 byte shorter than the wire form.
      expect(cm?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(cm?.companyName).toBe('Flexport');
      expect(cm?.location?.city).toBe('Guadalajara, Mexico');
      expect(cm?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Partnerships'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity).
      expect(cm?.department).toBe('Partnerships');
      expect(cm?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-10 lock for the second listing too.
      expect(cm?.jobUrl).toBe(
        'https://boards.greenhouse.io/flexport/jobs/7651413?gh_jid=7651413',
      );
      expect(cm?.jobUrl).toContain('boards.greenhouse.io/flexport/jobs/');
      expect(cm?.jobUrl).toContain('?gh_jid=');
      expect(cm?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(cm?.description).not.toContain('<p>');
      expect(cm?.description).not.toContain('<h2>');
      expect(cm?.description).toContain('Country Manager');
      expect(cm?.description).toContain('Mexico');

      // Regression guard: the slug must be `flexport` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/flexport/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FlexportService();
      const input: ScraperInputDto = {
        siteType: [Site.FLEXPORT],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FlexportService();
      const result = await service.scrape({
        siteType: [Site.FLEXPORT],
        searchTerm: 'COUNTRY MANAGER',
      } as ScraperInputDto);

      // Only the second fixture job has 'Country Manager' in its
      // title (`'Country Manager, Mexico'` after trim); the
      // case-insensitive match on the literal `'COUNTRY MANAGER'`
      // substring matches the trimmed second listing's title
      // byte-for-byte. The first listing's title ('Account
      // Executive, ENT') and dept ('Sales') do not contain 'country
      // manager', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('flexport-7651413');
      // Lock the D-10 application observable — the emitted title for
      // the matched listing carries the trimmed form (no pad byte).
      expect(result.jobs[0].title).toBe('Country Manager, Mexico');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FlexportService();
      const result = await service.scrape({
        siteType: [Site.FLEXPORT],
        searchTerm: 'partnerships',
      } as ScraperInputDto);

      // Only the second fixture job has `'Partnerships'` as its
      // department; the case-insensitive match on the literal
      // `'partnerships'` substring matches the literal
      // `'Partnerships'` department name. The first listing's
      // title-search miss ('Account Executive, ENT' does not
      // contain 'partnerships') and dept miss ('Sales' does not
      // contain 'partnerships') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('flexport-7651413');
      expect(result.jobs[0].department).toBe('Partnerships');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FlexportService();
      const result = await service.scrape({
        siteType: [Site.FLEXPORT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FlexportService();
      const result = await service.scrape({
        siteType: [Site.FLEXPORT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
