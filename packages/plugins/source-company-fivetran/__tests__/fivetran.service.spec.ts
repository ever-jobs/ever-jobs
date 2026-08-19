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

import { FivetranModule, FivetranService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'fivetran-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 082 / T04 — `FivetranService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FivetranService` through `FivetranModule`.
 *   2. `Site.FIVETRAN === 'fivetran'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL
 *      uses the bare slug `fivetran`, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#8217;`)
 *      AND tags stripped (D-08), (c) the variant-19
 *      `www.fivetran.com/careers/job?gh_jid=<id>` `absolute_url`
 *      flows through byte-for-byte (D-04 — first plugin in the
 *      cohort to use variant 19, the **twenty-second distinct
 *      wire-shape variant** in the company-direct cohort), (d)
 *      **D-09 application lock — first cohort observation of D-09
 *      application**: emitted `companyName === 'Fivetran'` (8
 *      bytes) AND byte-distinct from the wire `company_name ===
 *      'Fivetran '` (9 bytes — single trailing ASCII-space pad)
 *      AND exactly **1 byte shorter** (locking the trailing-pad-
 *      trim observable; first cohort plugin to apply D-09), (e)
 *      D-10 omission lock — emitted `title` for both listings
 *      equals wire `title` byte-for-byte (clean form), (f) D-11
 *      omission lock — emitted `department` for both listings
 *      equals wire `departments[0].name` byte-for-byte (clean
 *      form including the `' Department'` suffix preserved as
 *      structural data — `'Engineering Department'`, `'Sales
 *      Department'`).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('FivetranService — Spec 082 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FivetranModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FivetranModule],
      }).compile();
      const service = moduleRef.get(FivetranService);
      expect(service).toBeInstanceOf(FivetranService);
      await moduleRef.close();
    });

    it('exports the Site.FIVETRAN = "fivetran" enum value', () => {
      expect(Site.FIVETRAN).toBe('fivetran');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FivetranService();
      const input: ScraperInputDto = {
        siteType: [Site.FIVETRAN],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'fivetran-7687193003');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.FIVETRAN);
      // **D-09 application lock — first cohort observation of
      // D-09 application**: emitted `companyName` is the trimmed
      // 8-byte `'Fivetran'` (no trailing space) AND byte-distinct
      // from the wire `company_name === 'Fivetran '` (9 bytes —
      // single trailing ASCII-space pad) AND exactly 1 byte
      // shorter than the wire. First cohort plugin to apply D-09
      // — opening a new sub-axis alongside the existing thirty-
      // one D-09 omission cases.
      expect(eng?.companyName).toBe('Fivetran');
      expect(eng?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(JOBS_PAGE_RAW.jobs[0].company_name).toBe('Fivetran ');
      expect(JOBS_PAGE_RAW.jobs[0].company_name.endsWith(' ')).toBe(true);
      expect(eng?.companyName?.endsWith(' ')).toBe(false);
      expect(eng?.companyName!.length).toBe(JOBS_PAGE_RAW.jobs[0].company_name.length - 1);
      // Case-insensitively-equal to the lowercase slug `fivetran`
      // after trimming.
      expect(eng?.companyName?.toLowerCase()).toBe('fivetran');
      // First-listing title is wire-clean — D-10 omitted, pass-
      // through preserves byte-fidelity.
      expect(eng?.title).toBe('Senior Software Engineer');
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant-19 `www.`-prefixed brand-domain
      // singular `/careers/job` query-only-id shape.
      expect(eng?.jobUrl).toBe(
        'https://www.fivetran.com/careers/job?gh_jid=7687193003',
      );
      expect(eng?.jobUrl).toContain('www.fivetran.com/careers/job?gh_jid=');
      expect(eng?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // First-listing department is wire-clean — D-11 omitted,
      // pass-through preserves byte-fidelity (including the
      // structural `' Department'` suffix).
      expect(eng?.department).toBe('Engineering Department');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // Location — Fivetran's Oakland HQ.
      expect(eng?.location?.city).toBe('Oakland, CA');
      expect(eng?.isRemote).toBe(false);
      // D-08 regression guard: decode-then-strip pipeline.
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('&quot;');
      expect(eng?.description).not.toContain('&amp;');
      expect(eng?.description).not.toContain('&#8217;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      // Sanity: role-specific body content survives.
      expect(eng?.description).toContain('Fivetran');
      expect(eng?.description).toContain('data-pipeline');

      const ae = dto.jobs.find((j) => j.id === 'fivetran-7503045003');
      expect(ae).toBeDefined();
      expect(ae?.title).toBe('Account Executive');
      // D-09 application lock for second listing too — both wire
      // listings carry the `'Fivetran '` trailing-pad form.
      expect(ae?.companyName).toBe('Fivetran');
      expect(ae?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[1].company_name);
      expect(JOBS_PAGE_RAW.jobs[1].company_name).toBe('Fivetran ');
      expect(ae?.companyName?.endsWith(' ')).toBe(false);
      expect(ae?.location?.city).toBe('Remote, USA');
      expect(ae?.isRemote).toBe(true);
      expect(ae?.department).toBe('Sales Department');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-19 lock for second listing.
      expect(ae?.jobUrl).toBe(
        'https://www.fivetran.com/careers/job?gh_jid=7503045003',
      );
      expect(ae?.jobUrl).toContain('www.fivetran.com/careers/job?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode.
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Fivetran HVR');

      // Regression guard: the slug must be `fivetran` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/fivetran/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FivetranService();
      const input: ScraperInputDto = {
        siteType: [Site.FIVETRAN],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FivetranService();
      const result = await service.scrape({
        siteType: [Site.FIVETRAN],
        searchTerm: 'EXECUTIVE',
      } as ScraperInputDto);

      // Only the second fixture job has 'Executive' in its title.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fivetran-7503045003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FivetranService();
      const result = await service.scrape({
        siteType: [Site.FIVETRAN],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Only the second fixture job has `'Sales Department'` as
      // its department.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fivetran-7503045003');
      expect(result.jobs[0].department).toBe('Sales Department');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FivetranService();
      const result = await service.scrape({
        siteType: [Site.FIVETRAN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FivetranService();
      const result = await service.scrape({
        siteType: [Site.FIVETRAN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
