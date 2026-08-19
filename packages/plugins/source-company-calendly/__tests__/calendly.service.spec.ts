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

import { CalendlyModule, CalendlyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'calendly-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 080 / T04 — `CalendlyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CalendlyService` through `CalendlyModule`.
 *   2. `Site.CALENDLY === 'calendly'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `calendly`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the canonical variant-2
 *      `job-boards.greenhouse.io/calendly/jobs/<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — return-to-baseline shape
 *      after Bitwarden's variant-18 first-cohort observation in
 *      Spec 079; the **twentieth cohort plugin** to use canonical
 *      variant 2), (d) the emitted `companyName` is the case-
 *      symmetric wire `'Calendly'` byte-for-byte AND matches the
 *      wire `company_name` byte-for-byte AND is case-insensitively-
 *      equal to the slug `calendly`, (e) **D-10 trim lock** — the
 *      emitted `title` for the SECOND listing equals trimmed form
 *      `'Sr. Director, Engineering'` AND is byte-distinct from
 *      wire-padded form `'Sr. Director, Engineering '` AND is
 *      exactly **1 byte shorter** (locking the single-trailing-pad
 *      form), (f) the emitted `department` for the FIRST listing
 *      matches the wire `departments[0].name` byte-for-byte
 *      (`'Marketing'` — clean single-token form, D-11 pass-
 *      through), and (g) the emitted `department` for the SECOND
 *      listing matches the wire `departments[0].name` byte-for-
 *      byte (`'Engineering'` — clean single-token form, D-11 pass-
 *      through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('CalendlyService — Spec 080 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CalendlyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CalendlyModule],
      }).compile();
      const service = moduleRef.get(CalendlyService);
      expect(service).toBeInstanceOf(CalendlyService);
      await moduleRef.close();
    });

    it('exports the Site.CALENDLY = "calendly" enum value', () => {
      expect(Site.CALENDLY).toBe('calendly');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CalendlyService();
      const input: ScraperInputDto = {
        siteType: [Site.CALENDLY],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const marketing = dto.jobs.find((j) => j.id === 'calendly-8525369002');
      expect(marketing).toBeDefined();
      expect(marketing?.site).toBe(Site.CALENDLY);
      // D-09 omission lock with case-symmetric wire variant: the
      // emitted `companyName` is the bare-brand `'Calendly'` byte-
      // for-byte AND matches the wire `company_name` byte-for-byte
      // AND is case-insensitively-equal to the lowercase slug
      // `calendly`. Thirtieth cohort plugin to omit D-09.
      expect(marketing?.companyName).toBe('Calendly');
      expect(marketing?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(marketing?.companyName?.toLowerCase()).toBe('calendly');
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(marketing?.title).toBe('Director, Customer Education');
      expect(marketing?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Calendly's tenant publishes `absolute_url` on
      // canonical Greenhouse wire-shape variant 2 — the
      // `https://job-boards.greenhouse.io/calendly/jobs/<id>`
      // shape. The plugin emits `listing.absolute_url` byte-for-
      // byte. Return-to-baseline shape after Bitwarden's variant-18
      // first-cohort observation in Spec 079.
      expect(marketing?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/calendly/jobs/8525369002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io/calendly/jobs/` substring AND must
      // NOT contain the trailing-slash-before-query `/?gh_jid=`
      // substring (locking the variant-2 baseline shape against
      // any cross-pollination from variant-18 patterns). It must
      // NOT contain `calendly.com/careers/` (locking the variant-2
      // shape against falling back to a bare brand-domain shape).
      expect(marketing?.jobUrl).toContain('job-boards.greenhouse.io/calendly/jobs/');
      expect(marketing?.jobUrl).not.toContain('/?gh_jid=');
      expect(marketing?.jobUrl).not.toContain('calendly.com/careers/');
      // Location — Calendly's US remote on the first listing.
      expect(marketing?.location?.city).toBe('Remote - US');
      expect(marketing?.isRemote).toBe(true);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Marketing'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity to
      // the wire shape).
      expect(marketing?.department).toBe('Marketing');
      expect(marketing?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&amp;` (ampersand entities not decoded), `&quot;` (named
      // entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>` (tags not
      // stripped after decode).
      expect(marketing?.description).not.toContain('&lt;');
      expect(marketing?.description).not.toContain('&amp;');
      expect(marketing?.description).not.toContain('&quot;');
      expect(marketing?.description).not.toContain('&#39;');
      expect(marketing?.description).not.toContain('<p>');
      expect(marketing?.description).not.toContain('<div>');
      expect(marketing?.description).not.toContain('<strong>');
      // Sanity: the role-specific body content survives the strip.
      expect(marketing?.description).toContain('Calendly');
      expect(marketing?.description).toContain('scheduling-automation');

      const eng = dto.jobs.find((j) => j.id === 'calendly-8512146002');
      expect(eng).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Sr. Director, Engineering'` (no trailing pad bytes)
      // AND is byte-distinct from the wire form `'Sr. Director,
      // Engineering '` (with one trailing pad byte) AND is exactly
      // 1 byte shorter. Nineteenth cohort plugin to apply D-10.
      expect(eng?.title).toBe('Sr. Director, Engineering');
      expect(eng?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Sr. Director, Engineering ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(eng?.title.endsWith(' ')).toBe(false);
      expect(eng?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(eng?.companyName).toBe('Calendly');
      expect(eng?.location?.city).toBe('Atlanta, GA');
      expect(eng?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Engineering'` byte-for-byte
      // (clean single-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(eng?.department).toBe('Engineering');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-2 lock for the second listing too.
      expect(eng?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/calendly/jobs/8512146002',
      );
      expect(eng?.jobUrl).toContain('job-boards.greenhouse.io/calendly/jobs/');
      expect(eng?.jobUrl).not.toContain('/?gh_jid=');
      expect(eng?.jobUrl).not.toContain('calendly.com/careers/');
      // Tags stripped after decode.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).toContain('Calendly-for-Teams');
      expect(eng?.description).toContain('Calendly');

      // Regression guard: the slug must be `calendly` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/calendly/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CalendlyService();
      const input: ScraperInputDto = {
        siteType: [Site.CALENDLY],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CalendlyService();
      const result = await service.scrape({
        siteType: [Site.CALENDLY],
        searchTerm: 'SR. DIRECTOR',
      } as ScraperInputDto);

      // Only the second fixture job has 'Sr. Director' in its title
      // (trimmed `'Sr. Director, Engineering'`); the case-
      // insensitive match on `'SR. DIRECTOR'` matches the trimmed
      // second listing's title byte-for-byte. The first listing's
      // title ('Director, Customer Education') does not start with
      // 'sr.' so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('calendly-8512146002');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('Sr. Director, Engineering');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CalendlyService();
      const result = await service.scrape({
        siteType: [Site.CALENDLY],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      // Only the first fixture job has `'Marketing'` as its
      // department (the second listing's title 'Sr. Director,
      // Engineering' and dept 'Engineering' do not contain
      // 'marketing', so it filters out).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('calendly-8525369002');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CalendlyService();
      const result = await service.scrape({
        siteType: [Site.CALENDLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CalendlyService();
      const result = await service.scrape({
        siteType: [Site.CALENDLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
