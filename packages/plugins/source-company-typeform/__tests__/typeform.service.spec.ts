import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { TypeformModule, TypeformService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'typeform-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 089 / T04 — `TypeformService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `TypeformService` through `TypeformModule`.
 *   2. `Site.TYPEFORM === 'typeform'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-2 URL byte-for-
 *      byte pass-through, decode-then-strip pipeline cleanliness,
 *      case-symmetric wire `companyName === 'Typeform'`, D-10
 *      omission lock (titles pass through unchanged), AND D-11
 *      application lock (department `'Product '` → `'Product'`,
 *      byte-distinct, exactly 1 byte shorter).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department (D-11 search guard).
 *   7. HTTP 500 → `{ jobs: [] }`.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('TypeformService — Spec 089 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through TypeformModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TypeformModule],
      }).compile();
      const service = moduleRef.get(TypeformService);
      expect(service).toBeInstanceOf(TypeformService);
      await moduleRef.close();
    });

    it('exports the Site.TYPEFORM = "typeform" enum value', () => {
      expect(Site.TYPEFORM).toBe('typeform');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'typeform-6912450003');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.TYPEFORM);
      // D-09 omission lock: case-symmetric wire `'Typeform'`.
      expect(ae?.companyName).toBe('Typeform');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ae?.companyName?.toLowerCase()).toBe('typeform');
      // D-10 omission lock — wire title pass-through (clean wire).
      expect(ae?.title).toBe('Account Executive - EU');
      expect(ae?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock — variant-2 canonical Greenhouse host shape.
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/typeform/jobs/6912450003',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/typeform/jobs/');
      // First-listing dept clean — D-11 trim is a no-op on clean wire.
      expect(ae?.department).toBe('Sales');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae?.location?.city).toBe('Barcelona, Spain');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('&#39;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<h2>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Typeform');
      expect(ae?.description).toContain('Account Executive');

      const designer = dto.jobs.find((j) => j.id === 'typeform-6953711003');
      expect(designer).toBeDefined();
      // D-10 omission lock — second listing title also clean.
      expect(designer?.title).toBe('Senior Product Designer');
      expect(designer?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(designer?.companyName).toBe('Typeform');
      expect(designer?.location?.city).toBe('Remote - Europe');
      expect(designer?.isRemote).toBe(true);
      // D-11 application lock — single-trailing-pad form: emitted
      // `department` for the second listing equals trimmed form
      // `'Product'` (no trailing pad bytes) AND byte-distinct from
      // wire form `'Product '` (with one trailing pad byte) AND
      // exactly 1 byte shorter. Third cohort plugin to apply D-11.
      expect(designer?.department).toBe('Product');
      expect(designer?.department).not.toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Product ');
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name.endsWith(' ')).toBe(true);
      expect(designer?.department?.endsWith(' ')).toBe(false);
      expect(designer?.department?.length).toBe(
        JOBS_PAGE_RAW.jobs[1].departments[0].name.length - 1,
      );
      // Variant-2 lock for second listing.
      expect(designer?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/typeform/jobs/6953711003',
      );
      expect(designer?.jobUrl).toContain('job-boards.greenhouse.io/typeform/jobs/');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/typeform/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
        searchTerm: 'DESIGNER',
      } as ScraperInputDto);

      // 'Designer' only in second listing.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('typeform-6953711003');
      expect(result.jobs[0].title).toBe('Senior Product Designer');
    });

    it('filters by case-insensitive substring of department name (D-11 search guard — match is on trimmed form)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
        searchTerm: 'product',
      } as ScraperInputDto);

      // Only the second listing has `'Product'` as its department
      // (trimmed from wire-padded `'Product '`); the first listing's
      // dept is 'Sales' and title is 'Account Executive - EU' —
      // neither contains 'product'. D-11 search guard: the search
      // runs against the trimmed department form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('typeform-6953711003');
      expect(result.jobs[0].department).toBe('Product');
      expect(result.jobs[0].department?.endsWith(' ')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new TypeformService();
      const result = await service.scrape({
        siteType: [Site.TYPEFORM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
