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

import { MavenclinicModule, MavenclinicService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'mavenclinic-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 076 / T04 — `MavenclinicService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MavenclinicService` through `MavenclinicModule`.
 *   2. `Site.MAVENCLINIC === 'mavenclinic'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `mavenclinic`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-2 modern hosted-board
 *      `job-boards.greenhouse.io/mavenclinic/jobs/<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — seventeenth plugin in the
 *      cohort to use variant 2), (d) the emitted `companyName` is the
 *      internal-whitespace-asymmetric wire `'Maven Clinic'` byte-for-
 *      byte AND matches the wire `company_name` byte-for-byte AND is
 *      byte-distinct from the slug `mavenclinic` AND is exactly
 *      **1 byte longer** than the slug (locking the slug/wire
 *      internal-whitespace asymmetry — D-09 omission lock, the
 *      **second** cohort case where wire and slug differ by an
 *      internal whitespace byte after Scale AI; same +1 byte
 *      differential, same single-internal-space delta), (e)
 *      **D-10 trim lock** — the emitted `title` for the SECOND
 *      listing equals trimmed form `'Clinical Outcomes Analyst'`
 *      AND is byte-distinct from wire-padded form `'Clinical
 *      Outcomes Analyst '` AND is exactly **1 byte shorter**
 *      (locking the single-trailing-pad form), (f) the emitted
 *      `department` for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Brand &
 *      Communications'` — clean multi-token form with internal
 *      ampersand and whitespace, D-11 pass-through), and (g) the
 *      emitted `department` for the SECOND listing matches the
 *      wire `departments[0].name` byte-for-byte (`'Clinical
 *      Outcomes'` — clean multi-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('MavenclinicService — Spec 076 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MavenclinicModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MavenclinicModule],
      }).compile();
      const service = moduleRef.get(MavenclinicService);
      expect(service).toBeInstanceOf(MavenclinicService);
      await moduleRef.close();
    });

    it('exports the Site.MAVENCLINIC = "mavenclinic" enum value', () => {
      expect(Site.MAVENCLINIC).toBe('mavenclinic');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenclinicService();
      const input: ScraperInputDto = {
        siteType: [Site.MAVENCLINIC],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const brand = dto.jobs.find((j) => j.id === 'mavenclinic-8500217002');
      expect(brand).toBeDefined();
      expect(brand?.site).toBe(Site.MAVENCLINIC);
      // D-09 omission lock with internal-whitespace wire variant: the
      // emitted `companyName` is the two-word `'Maven Clinic'` byte-
      // for-byte AND matches the wire `company_name` byte-for-byte
      // AND is byte-distinct from the lowercase concatenated slug
      // `mavenclinic` AND is exactly 1 byte longer than the slug
      // (locking the internal-whitespace asymmetry — second cohort
      // observation of this asymmetry shape after Scale AI). Twenty-
      // sixth cohort plugin to omit D-09.
      expect(brand?.companyName).toBe('Maven Clinic');
      expect(brand?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(brand?.companyName).not.toBe('mavenclinic');
      expect(brand?.companyName!.length).toBe('mavenclinic'.length + 1);
      // Case-insensitively-with-space-collapsed equality lock — the
      // emitted `companyName` collapses to the lowercase slug when
      // the internal space is removed. This guards against future
      // wire-side normalisation that drops the space (which would
      // make the wire equal-byte-length to the slug — case-only
      // asymmetry like MasterClass).
      expect(brand?.companyName?.toLowerCase().replace(/\s+/g, '')).toBe('mavenclinic');
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(brand?.title).toBe('Brand Designer');
      expect(brand?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Maven Clinic's tenant publishes `absolute_url` on
      // wire-shape variant 2 — the modern
      // `https://job-boards.greenhouse.io/mavenclinic/jobs/<id>` shape.
      // The plugin emits `listing.absolute_url` byte-for-byte.
      // Seventeenth plugin in the cohort to use variant 2.
      expect(brand?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/mavenclinic/jobs/8500217002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io/mavenclinic/jobs/` substring
      // (variant-2 modern apex) AND must NOT contain `?gh_jid=`
      // (locking the variant-2 shape against future refactors that
      // might naively normalise to variant 10).
      expect(brand?.jobUrl).toContain('job-boards.greenhouse.io/mavenclinic/jobs/');
      expect(brand?.jobUrl).not.toContain('?gh_jid=');
      // Location — Maven Clinic's NYC HQ on the first listing.
      expect(brand?.location?.city).toBe('New York, NY');
      expect(brand?.isRemote).toBe(false);
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Brand & Communications'` byte-for-
      // byte (clean multi-token form with internal ampersand and
      // whitespace; pass-through preserves byte-fidelity to the wire
      // shape).
      expect(brand?.department).toBe('Brand & Communications');
      expect(brand?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&quot;` (named entities not decoded), `&amp;` (ampersand
      // entities not decoded), or literal `<p>`/`<div>`/`<strong>`/
      // `<em>` (tags not stripped after decode).
      expect(brand?.description).not.toContain('&lt;');
      expect(brand?.description).not.toContain('&quot;');
      expect(brand?.description).not.toContain('&amp;');
      expect(brand?.description).not.toContain('<p>');
      expect(brand?.description).not.toContain('<div>');
      expect(brand?.description).not.toContain('<strong>');
      expect(brand?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(brand?.description).toContain('Maven');
      expect(brand?.description).toContain('Brand');

      const coa = dto.jobs.find((j) => j.id === 'mavenclinic-8521374002');
      expect(coa).toBeDefined();
      // D-10 application lock — single-trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'Clinical Outcomes Analyst'` (no trailing pad bytes)
      // AND is byte-distinct from the wire form `'Clinical Outcomes
      // Analyst '` (with one trailing pad byte) AND is exactly 1
      // byte shorter. Fifteenth cohort plugin to apply D-10.
      expect(coa?.title).toBe('Clinical Outcomes Analyst');
      expect(coa?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Clinical Outcomes Analyst ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(coa?.title.endsWith(' ')).toBe(false);
      expect(coa?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(coa?.companyName).toBe('Maven Clinic');
      expect(coa?.location?.city).toBe('Remote - United States');
      expect(coa?.isRemote).toBe(true);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Clinical Outcomes'` byte-
      // for-byte (clean multi-token form; pass-through preserves
      // byte-fidelity to the wire shape).
      expect(coa?.department).toBe('Clinical Outcomes');
      expect(coa?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-2 lock for the second listing too.
      expect(coa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/mavenclinic/jobs/8521374002',
      );
      expect(coa?.jobUrl).toContain('job-boards.greenhouse.io/mavenclinic/jobs/');
      expect(coa?.jobUrl).not.toContain('?gh_jid=');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(coa?.description).not.toContain('<p>');
      expect(coa?.description).not.toContain('<strong>');
      expect(coa?.description).toContain('Clinical Outcomes');
      expect(coa?.description).toContain('Maven');

      // Regression guard: the slug must be `mavenclinic` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/mavenclinic/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenclinicService();
      const input: ScraperInputDto = {
        siteType: [Site.MAVENCLINIC],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenclinicService();
      const result = await service.scrape({
        siteType: [Site.MAVENCLINIC],
        searchTerm: 'ANALYST',
      } as ScraperInputDto);

      // Only the second fixture job has 'Analyst' in its title
      // (trimmed `'Clinical Outcomes Analyst'`); the case-
      // insensitive match on the literal `'ANALYST'` substring
      // matches the trimmed second listing's title byte-for-byte.
      // The first listing's title ('Brand Designer') and dept
      // ('Brand & Communications') do not contain 'analyst', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mavenclinic-8521374002');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('Clinical Outcomes Analyst');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenclinicService();
      const result = await service.scrape({
        siteType: [Site.MAVENCLINIC],
        searchTerm: 'brand',
      } as ScraperInputDto);

      // Only the first fixture job has `'Brand & Communications'`
      // as its department (the title `'Brand Designer'` also
      // contains 'brand', so the title path also matches; either
      // way the same listing is returned). The second listing's
      // title ('Clinical Outcomes Analyst') and dept ('Clinical
      // Outcomes') do not contain 'brand', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('mavenclinic-8500217002');
      expect(result.jobs[0].department).toBe('Brand & Communications');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MavenclinicService();
      const result = await service.scrape({
        siteType: [Site.MAVENCLINIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MavenclinicService();
      const result = await service.scrape({
        siteType: [Site.MAVENCLINIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
