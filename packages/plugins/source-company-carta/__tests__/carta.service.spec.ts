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

import { CartaModule, CartaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'carta-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 066 / T04 — `CartaService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CartaService` through `CartaModule`.
 *   2. `Site.CARTA === 'carta'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `carta`, (b) the description has named entities
 *      (`&quot;`), numeric entities (`&#39;`), AND tags stripped
 *      (D-08), (c) the variant-2 US-region permalink `absolute_url`
 *      flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/carta/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the single-token bare-brand display
 *      `'Carta'` byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) the emitted `title`
 *      for the SECOND listing is the trimmed form `'Business
 *      Development Manager, Private Equity'` AND is byte-distinct
 *      from the wire form `'Business Development Manager, Private
 *      Equity '` (D-10 application lock — `.trim()` observable),
 *      (f) the emitted `department` for the FIRST listing matches
 *      the wire `departments[0].name` byte-for-byte (`'Account
 *      Executive'` — clean multi-word descriptive form, D-11
 *      pass-through), and (g) the emitted `department` for the
 *      SECOND listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Marketing'` — clean single-token form,
 *      D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CartaService — Spec 066 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CartaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CartaModule],
      }).compile();
      const service = moduleRef.get(CartaService);
      expect(service).toBeInstanceOf(CartaService);
      await moduleRef.close();
    });

    it('exports the Site.CARTA = "carta" enum value', () => {
      expect(Site.CARTA).toBe('carta');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CartaService();
      const input: ScraperInputDto = {
        siteType: [Site.CARTA],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'carta-7591992003');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.CARTA);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand display `'Carta'` byte-for-byte AND
      // matches the wire `company_name` byte-for-byte. Sixteenth
      // cohort plugin to omit D-09.
      expect(ae?.companyName).toBe('Carta');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(ae?.title).toBe('Account Executive, Fund Administration');
      expect(ae?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // Wire shape: Carta's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // carta/jobs/<id>` — variant 2 (the fourteenth plugin in the
      // cohort to use this shape) (Spec 066 § 10 D-04).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/carta/jobs/7591992003',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/carta/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a variant-10 or
      // variant-11 template).
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(ae?.jobUrl).toContain('/carta/jobs/');
      expect(ae?.jobUrl).not.toContain('?gh_jid=');
      expect(ae?.location?.city).toBe('Sydney, Australia');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Account Executive'` byte-for-byte
      // (clean multi-word descriptive form; pass-through preserves
      // byte-fidelity to the wire shape).
      expect(ae?.department).toBe('Account Executive');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae?.isRemote).toBe(false);
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
      expect(ae?.description).toContain('Carta');
      expect(ae?.description).toContain('Fund Administration');

      const bdm = dto.jobs.find((j) => j.id === 'carta-7717037003');
      expect(bdm).toBeDefined();
      // D-10 application lock: the emitted `title` for the second
      // listing equals the trimmed form `'Business Development Manager,
      // Private Equity'` (no trailing pad byte) AND is byte-distinct
      // from the wire form `'Business Development Manager, Private
      // Equity '` (with trailing pad byte). Locking the D-10
      // application against a future refactor that drops the
      // `.trim()` and reintroduces the wire pad byte. Ninth cohort
      // plugin to apply D-10.
      expect(bdm?.title).toBe('Business Development Manager, Private Equity');
      expect(bdm?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Business Development Manager, Private Equity ',
      );
      // The wire title closes with a trailing pad byte; the emitted
      // title closes with the alphabetic byte 'y'.
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(bdm?.title.endsWith(' ')).toBe(false);
      expect(bdm?.companyName).toBe('Carta');
      expect(bdm?.location?.city).toBe('New York');
      expect(bdm?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Marketing'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity).
      expect(bdm?.department).toBe('Marketing');
      expect(bdm?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(bdm?.description).not.toContain('<p>');
      expect(bdm?.description).not.toContain('<h2>');
      expect(bdm?.description).toContain('Business Development Manager');
      expect(bdm?.description).toContain('Private Equity');

      // Regression guard: the slug must be `carta` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/carta/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CartaService();
      const input: ScraperInputDto = {
        siteType: [Site.CARTA],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CartaService();
      const result = await service.scrape({
        siteType: [Site.CARTA],
        searchTerm: 'PRIVATE EQUITY',
      } as ScraperInputDto);

      // Only the second fixture job has 'Private Equity' in its
      // title (`'Business Development Manager, Private Equity'`
      // after trim); the case-insensitive match on the literal
      // `'PRIVATE EQUITY'` substring matches the trimmed second
      // listing's title byte-for-byte. The first listing's
      // title-search miss ('Account Executive, Fund Administration'
      // does not contain 'private equity') and dept miss ('Account
      // Executive' does not contain 'private equity') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('carta-7717037003');
      // Lock the D-10 application observable — the emitted title for
      // the matched listing carries the trimmed form (no pad byte).
      expect(result.jobs[0].title).toBe(
        'Business Development Manager, Private Equity',
      );
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CartaService();
      const result = await service.scrape({
        siteType: [Site.CARTA],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      // Only the second fixture job has `'Marketing'` as its
      // department; the case-insensitive match on the literal
      // `'marketing'` substring matches the literal `'Marketing'`
      // department name. The first listing's title-search miss
      // ('Account Executive, Fund Administration' does not contain
      // 'marketing') and dept miss ('Account Executive' does not
      // contain 'marketing') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('carta-7717037003');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CartaService();
      const result = await service.scrape({
        siteType: [Site.CARTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CartaService();
      const result = await service.scrape({
        siteType: [Site.CARTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
