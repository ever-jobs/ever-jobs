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

import { BitwardenModule, BitwardenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bitwarden-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 079 / T04 — `BitwardenService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BitwardenService` through `BitwardenModule`.
 *   2. `Site.BITWARDEN === 'bitwarden'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `bitwarden`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-18 bare brand-domain
 *      `bitwarden.com/careers/<id>/?gh_jid=<id>` `absolute_url`
 *      flows through byte-for-byte INCLUDING the trailing slash
 *      before `?gh_jid=` (D-04 — first plugin in the cohort to
 *      use variant 18, the **twenty-first distinct wire-shape
 *      variant** in the company-direct cohort), (d) the emitted
 *      `companyName` is the case-symmetric wire `'Bitwarden'`
 *      byte-for-byte AND matches the wire `company_name` byte-
 *      for-byte AND is case-insensitively-equal to the slug
 *      `bitwarden`, (e) **D-10 trim lock** — the emitted `title`
 *      for the SECOND listing equals trimmed form `'Senior Full
 *      Stack Software Engineer'` AND is byte-distinct from
 *      wire-padded form `'Senior Full Stack Software Engineer '`
 *      AND is exactly **1 byte shorter** (locking the single-
 *      trailing-pad form), (f) the emitted `department` for the
 *      FIRST listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Engineering'` — clean single-token form,
 *      D-11 pass-through), and (g) the emitted `department` for
 *      the SECOND listing matches the wire `departments[0].name`
 *      byte-for-byte (`'Sales'` — clean single-token form, D-11
 *      pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('BitwardenService — Spec 079 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BitwardenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BitwardenModule],
      }).compile();
      const service = moduleRef.get(BitwardenService);
      expect(service).toBeInstanceOf(BitwardenService);
      await moduleRef.close();
    });

    it('exports the Site.BITWARDEN = "bitwarden" enum value', () => {
      expect(Site.BITWARDEN).toBe('bitwarden');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitwardenService();
      const input: ScraperInputDto = {
        siteType: [Site.BITWARDEN],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const backend = dto.jobs.find((j) => j.id === 'bitwarden-7619106003');
      expect(backend).toBeDefined();
      expect(backend?.site).toBe(Site.BITWARDEN);
      // D-09 omission lock with case-symmetric wire variant: the
      // emitted `companyName` is the bare-brand `'Bitwarden'` byte-
      // for-byte AND matches the wire `company_name` byte-for-byte
      // AND is case-insensitively-equal to the lowercase slug
      // `bitwarden`. Twenty-ninth cohort plugin to omit D-09.
      expect(backend?.companyName).toBe('Bitwarden');
      expect(backend?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(backend?.companyName?.toLowerCase()).toBe('bitwarden');
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(backend?.title).toBe('Senior Backend Engineer');
      expect(backend?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Bitwarden's tenant publishes `absolute_url` on
      // wire-shape variant 18 — the bare brand-domain
      // `https://bitwarden.com/careers/<id>/?gh_jid=<id>` shape
      // with the trailing slash before `?gh_jid=`. The plugin
      // emits `listing.absolute_url` byte-for-byte. First plugin
      // in the cohort to use variant 18 — the twenty-first
      // distinct wire-shape variant in the company-direct cohort.
      expect(backend?.jobUrl).toBe(
        'https://bitwarden.com/careers/7619106003/?gh_jid=7619106003',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `bitwarden.com/careers/` substring AND must contain the
      // trailing-slash-before-query `/?gh_jid=` substring (locking
      // the variant-18 trailing-slash shape against future
      // refactors that might naively normalise to a non-trailing-
      // slash form). It must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-18 shape against falling back to
      // variant 2).
      expect(backend?.jobUrl).toContain('bitwarden.com/careers/');
      expect(backend?.jobUrl).toContain('/?gh_jid=');
      expect(backend?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Location — Bitwarden's USA remote on the first listing.
      expect(backend?.location?.city).toBe('Remote, USA');
      expect(backend?.isRemote).toBe(true);
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
      // `&amp;` (ampersand entities not decoded), or literal
      // `<p>`/`<strong>` (tags not stripped after decode).
      expect(backend?.description).not.toContain('&lt;');
      expect(backend?.description).not.toContain('&amp;');
      expect(backend?.description).not.toContain('<p>');
      expect(backend?.description).not.toContain('<strong>');
      // Sanity: the role-specific body content survives the strip.
      expect(backend?.description).toContain('Bitwarden');
      expect(backend?.description).toContain('credential-vault');

      const fullstack = dto.jobs.find((j) => j.id === 'bitwarden-7640804003');
      expect(fullstack).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Senior Full Stack Software Engineer'` (no trailing
      // pad bytes) AND is byte-distinct from the wire form `'Senior
      // Full Stack Software Engineer '` (with one trailing pad
      // byte) AND is exactly 1 byte shorter. Eighteenth cohort
      // plugin to apply D-10.
      expect(fullstack?.title).toBe('Senior Full Stack Software Engineer');
      expect(fullstack?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Full Stack Software Engineer ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(fullstack?.title.endsWith(' ')).toBe(false);
      expect(fullstack?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(fullstack?.companyName).toBe('Bitwarden');
      expect(fullstack?.location?.city).toBe('Remote, EU');
      expect(fullstack?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Sales'` byte-for-byte
      // (clean single-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(fullstack?.department).toBe('Sales');
      expect(fullstack?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-18 lock for the second listing too.
      expect(fullstack?.jobUrl).toBe(
        'https://bitwarden.com/careers/7640804003/?gh_jid=7640804003',
      );
      expect(fullstack?.jobUrl).toContain('bitwarden.com/careers/');
      expect(fullstack?.jobUrl).toContain('/?gh_jid=');
      expect(fullstack?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode.
      expect(fullstack?.description).not.toContain('<p>');
      expect(fullstack?.description).not.toContain('<strong>');
      expect(fullstack?.description).toContain('Bitwarden-for-Business');
      expect(fullstack?.description).toContain('Bitwarden');

      // Regression guard: the slug must be `bitwarden` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bitwarden/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitwardenService();
      const input: ScraperInputDto = {
        siteType: [Site.BITWARDEN],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitwardenService();
      const result = await service.scrape({
        siteType: [Site.BITWARDEN],
        searchTerm: 'FULL STACK',
      } as ScraperInputDto);

      // Only the second fixture job has 'Full Stack' in its title
      // (trimmed `'Senior Full Stack Software Engineer'`); the
      // case-insensitive match on `'FULL STACK'` matches the
      // trimmed second listing's title byte-for-byte. The first
      // listing's title ('Senior Backend Engineer') and dept
      // ('Engineering') do not contain 'full stack', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bitwarden-7640804003');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('Senior Full Stack Software Engineer');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitwardenService();
      const result = await service.scrape({
        siteType: [Site.BITWARDEN],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Only the second fixture job has `'Sales'` as its department
      // (the first listing's title 'Senior Backend Engineer' and
      // dept 'Engineering' do not contain 'sales', so it filters
      // out).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bitwarden-7640804003');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BitwardenService();
      const result = await service.scrape({
        siteType: [Site.BITWARDEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BitwardenService();
      const result = await service.scrape({
        siteType: [Site.BITWARDEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
