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

import { CameoModule, CameoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cameo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 065 / T04 — `CameoService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CameoService` through `CameoModule`.
 *   2. `Site.CAMEO === 'cameo'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `cameo`, (b) the description has named entities
 *      (`&quot;`), numeric entities (`&#39;`), AND tags stripped
 *      (D-08), (c) the variant-2 US-region permalink `absolute_url`
 *      flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/cameo/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the single-token bare-brand display
 *      `'Cameo'` byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      matches the wire `title` byte-for-byte (D-10 omission lock —
 *      no observable `.trim()`), (f) the emitted `department` for
 *      the FIRST listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Engineering'` — single-token clean form),
 *      and (g) the emitted `department` for the SECOND listing
 *      matches the wire `departments[0].name` byte-for-byte
 *      (`'Cameo for Business '` — multi-token padded form, D-11
 *      partial-pad pass-through observability lock with the
 *      trailing ASCII-space byte preserved).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'business'` substring matching the
 *      padded multi-word department `'Cameo for Business '` in the
 *      second listing — D-11 padded multi-word search guard).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CameoService — Spec 065 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CameoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CameoModule],
      }).compile();
      const service = moduleRef.get(CameoService);
      expect(service).toBeInstanceOf(CameoService);
      await moduleRef.close();
    });

    it('exports the Site.CAMEO = "cameo" enum value', () => {
      expect(Site.CAMEO).toBe('cameo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CameoService();
      const input: ScraperInputDto = {
        siteType: [Site.CAMEO],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'cameo-7657872003');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.CAMEO);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand display `'Cameo'` byte-for-byte AND
      // matches the wire `company_name` byte-for-byte (locking the
      // wire-shape regression guard against the upstream tenant
      // adding a future legal-entity suffix). The plugin reads
      // `listing.company_name` directly. Fifteenth cohort plugin to
      // omit D-09, returning to the single-word bare-brand wire form
      // (distinct from Scale AI's first-of-its-kind multi-token bare-
      // brand wire).
      expect(eng?.companyName).toBe('Cameo');
      expect(eng?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 omission lock: emitted `title` matches the wire `title`
      // byte-for-byte (no observable `.trim()`). The fixture title
      // `'Automation Engineer'` is already trim-clean.
      expect(eng?.title).toBe('Automation Engineer');
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // Wire shape: Cameo's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // cameo/jobs/<id>` — variant 2 (the thirteenth plugin in the
      // cohort to use this shape) (Spec 065 § 10 D-04).
      expect(eng?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/cameo/jobs/7657872003',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/cameo/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a variant-10 or
      // variant-11 template).
      expect(eng?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(eng?.jobUrl).toContain('/cameo/jobs/');
      expect(eng?.jobUrl).not.toContain('?gh_jid=');
      expect(eng?.location?.city).toBe('Chicago, IL');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing is the single-token clean
      // string `'Engineering'` byte-for-byte AND matches the wire
      // `departments[0].name` byte-for-byte. The first listing's
      // department is trim-clean (no trailing pad byte).
      expect(eng?.department).toBe('Engineering');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(eng?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('&quot;');
      expect(eng?.description).not.toContain('&#39;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<div>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(eng?.description).toContain('Cameo');
      expect(eng?.description).toContain('Automation Engineer');
      expect(eng?.description).toContain('Cameo for Business');

      const bdr = dto.jobs.find((j) => j.id === 'cameo-6260240003');
      expect(bdr).toBeDefined();
      expect(bdr?.title).toBe(
        'Business Development Representative - Cameo for Business',
      );
      // D-10 omission: this fixture title is already trim-clean.
      expect(bdr?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(bdr?.companyName).toBe('Cameo');
      expect(bdr?.location?.city).toBe('Remote, United States');
      // The fixture location string contains "Remote" so isRemote
      // should be true.
      expect(bdr?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Cameo for Business '` byte-for-byte
      // WITH the trailing ASCII-space pad byte preserved (locking the
      // D-11 partial-pad pass-through observability against a future
      // refactor that introduces a spurious `.trim()` on the
      // department field). First cohort plugin to ship a wire
      // department-name with trailing ASCII-space padding pass-
      // through observability.
      expect(bdr?.department).toBe('Cameo for Business ');
      expect(bdr?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Lock the trailing pad byte explicitly: the emitted
      // department must end with an ASCII space.
      expect(bdr?.department?.endsWith(' ')).toBe(true);
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(bdr?.description).not.toContain('<p>');
      expect(bdr?.description).not.toContain('<h2>');
      expect(bdr?.description).toContain('Business Development Representative');
      expect(bdr?.description).toContain('Cameo for Business');

      // Regression guard: the slug must be `cameo` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cameo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CameoService();
      const input: ScraperInputDto = {
        siteType: [Site.CAMEO],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CameoService();
      const result = await service.scrape({
        siteType: [Site.CAMEO],
        searchTerm: 'AUTOMATION',
      } as ScraperInputDto);

      // Only the first fixture job has 'Automation' in its title
      // (`'Automation Engineer'`); the case-insensitive match on the
      // literal `'AUTOMATION'` substring matches the first listing's
      // title byte-for-byte. The second listing's title-search miss
      // ('Business Development Representative - Cameo for Business'
      // does not contain 'automation') and dept miss ('Cameo for
      // Business ' does not contain 'automation') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cameo-7657872003');
      expect(result.jobs[0].title).toBe('Automation Engineer');
    });

    it('filters by case-insensitive substring of padded multi-word department name (D-11 padded-pass-through search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CameoService();
      const result = await service.scrape({
        siteType: [Site.CAMEO],
        searchTerm: 'business',
      } as ScraperInputDto);

      // The second fixture job has `'Cameo for Business '` as its
      // padded multi-word department; the case-insensitive match on
      // the literal `'business'` substring matches the second
      // listing's padded department byte-for-byte (`'business'` is a
      // substring of `'cameo for business '` after lowercasing). The
      // second listing's title also contains 'Business' (`'Business
      // Development Representative - Cameo for Business'`) so the
      // title path matches too. The first listing's title-search
      // miss ('Automation Engineer' does not contain 'business') and
      // dept miss ('Engineering' does not contain 'business') filter
      // it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cameo-6260240003');
      // Lock the D-11 partial-pad pass-through observable — the
      // emitted department for the matched listing carries the
      // wire-padded form byte-for-byte.
      expect(result.jobs[0].department).toBe('Cameo for Business ');
    });

    it('filters by case-insensitive substring of department name on first listing — D-11 engineering-clean lock', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CameoService();
      const result = await service.scrape({
        siteType: [Site.CAMEO],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the first fixture job has `'Engineering'` as its
      // department; the case-insensitive match on the literal
      // `'engineering'` substring matches the literal `'Engineering'`
      // department name in the first listing. Note: the first
      // listing's title 'Automation Engineer' does not contain
      // 'engineering' (the title says 'Engineer', not 'Engineering'),
      // so only the dept match path fires. The second listing's
      // title-search miss and dept miss ('Cameo for Business ' does
      // not contain 'engineering') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cameo-7657872003');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CameoService();
      const result = await service.scrape({
        siteType: [Site.CAMEO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CameoService();
      const result = await service.scrape({
        siteType: [Site.CAMEO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
