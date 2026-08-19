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

import { LookoutModule, LookoutService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'lookout-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 083 / T04 — `LookoutService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `LookoutService` through `LookoutModule`.
 *   2. `Site.LOOKOUT === 'lookout'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL
 *      uses the bare slug `lookout`, (b) the description has
 *      named entities (`&quot;`), numeric entities (`&#8217;`)
 *      AND tags stripped (D-08), (c) the variant-20
 *      `www.lookout.com/careers/job-post?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04 — first
 *      plugin in the cohort to use variant 20, the **twenty-third
 *      distinct wire-shape variant** in the company-direct
 *      cohort), (d) **D-09 omission lock — returns to cohort
 *      default after Fivetran's first-cohort D-09 application
 *      at run #292**: emitted `companyName === 'Lookout'` (7
 *      bytes) AND byte-equal to the wire `company_name ===
 *      'Lookout'` (7 bytes — fully clean wire, no pad bytes),
 *      (e) D-10 omission lock — emitted `title` for both listings
 *      equals wire `title` byte-for-byte (clean form), (f) D-11
 *      omission lock — emitted `department` for both listings
 *      equals wire `departments[0].name` byte-for-byte (clean
 *      form — `'Engineering'` / `'Sales'` without the
 *      `' Department'` structural suffix that Fivetran's wire
 *      carries).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('LookoutService — Spec 083 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through LookoutModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [LookoutModule],
      }).compile();
      const service = moduleRef.get(LookoutService);
      expect(service).toBeInstanceOf(LookoutService);
      await moduleRef.close();
    });

    it('exports the Site.LOOKOUT = "lookout" enum value', () => {
      expect(Site.LOOKOUT).toBe('lookout');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LookoutService();
      const input: ScraperInputDto = {
        siteType: [Site.LOOKOUT],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'lookout-7843171');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.LOOKOUT);
      // **D-09 omission lock — returns to cohort-default D-09-
      // omitted posture after Fivetran's first-cohort D-09
      // application at run #292**: emitted `companyName` is the
      // clean 7-byte `'Lookout'` AND byte-equal to the wire
      // `company_name === 'Lookout'` (7 bytes — fully clean wire,
      // no leading or trailing pad). Thirty-second cohort plugin
      // to omit D-09.
      expect(eng?.companyName).toBe('Lookout');
      expect(eng?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(JOBS_PAGE_RAW.jobs[0].company_name).toBe('Lookout');
      expect(eng?.companyName?.endsWith(' ')).toBe(false);
      expect(eng?.companyName?.startsWith(' ')).toBe(false);
      expect(eng?.companyName!.length).toBe(JOBS_PAGE_RAW.jobs[0].company_name.length);
      expect(eng?.companyName!.length).toBe(7);
      // Case-insensitively-equal to the lowercase slug `lookout`.
      expect(eng?.companyName?.toLowerCase()).toBe('lookout');
      // First-listing title is wire-clean — D-10 omitted, pass-
      // through preserves byte-fidelity.
      expect(eng?.title).toBe('Senior Software Engineer - Backend');
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant-20 `www.`-prefixed brand-domain
      // singular `/careers/job-post` query-only-id shape.
      expect(eng?.jobUrl).toBe(
        'https://www.lookout.com/careers/job-post?gh_jid=7843171',
      );
      expect(eng?.jobUrl).toContain('www.lookout.com/careers/job-post?gh_jid=');
      expect(eng?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // First-listing department is wire-clean — D-11 omitted,
      // pass-through preserves byte-fidelity (bare role-domain
      // name `'Engineering'`, no `' Department'` suffix).
      expect(eng?.department).toBe('Engineering');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // Location — Lookout's San Francisco HQ.
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.isRemote).toBe(false);
      // D-08 regression guard: decode-then-strip pipeline.
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('&quot;');
      expect(eng?.description).not.toContain('&amp;');
      expect(eng?.description).not.toContain('&#8217;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      // Sanity: role-specific body content survives.
      expect(eng?.description).toContain('Lookout');
      expect(eng?.description).toContain('Mobile EDR');

      const ae = dto.jobs.find((j) => j.id === 'lookout-7503045003');
      expect(ae).toBeDefined();
      expect(ae?.title).toBe('Enterprise Account Development Representative');
      // D-09 omission lock for second listing too — both wire
      // listings carry the clean 7-byte `'Lookout'` form.
      expect(ae?.companyName).toBe('Lookout');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[1].company_name);
      expect(JOBS_PAGE_RAW.jobs[1].company_name).toBe('Lookout');
      expect(ae?.companyName?.endsWith(' ')).toBe(false);
      expect(ae?.companyName?.startsWith(' ')).toBe(false);
      expect(ae?.location?.city).toBe('Remote, USA');
      expect(ae?.isRemote).toBe(true);
      expect(ae?.department).toBe('Sales');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-20 lock for second listing.
      expect(ae?.jobUrl).toBe(
        'https://www.lookout.com/careers/job-post?gh_jid=7503045003',
      );
      expect(ae?.jobUrl).toContain('www.lookout.com/careers/job-post?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode.
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Lookout Mobile EDR');

      // Regression guard: the slug must be `lookout` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/lookout/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LookoutService();
      const input: ScraperInputDto = {
        siteType: [Site.LOOKOUT],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LookoutService();
      const result = await service.scrape({
        siteType: [Site.LOOKOUT],
        searchTerm: 'BACKEND',
      } as ScraperInputDto);

      // Only the first fixture job has 'Backend' in its title.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('lookout-7843171');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LookoutService();
      const result = await service.scrape({
        siteType: [Site.LOOKOUT],
        searchTerm: 'sales',
      } as ScraperInputDto);

      // Only the second fixture job has `'Sales'` as its
      // department.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('lookout-7503045003');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new LookoutService();
      const result = await service.scrape({
        siteType: [Site.LOOKOUT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new LookoutService();
      const result = await service.scrape({
        siteType: [Site.LOOKOUT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
