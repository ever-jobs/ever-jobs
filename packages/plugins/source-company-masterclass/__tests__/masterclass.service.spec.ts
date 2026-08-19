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

import { MasterclassModule, MasterclassService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'masterclass-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 075 / T04 — `MasterclassService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MasterclassService` through `MasterclassModule`.
 *   2. `Site.MASTERCLASS === 'masterclass'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-2 URL pass-through,
 *      decode-then-strip pipeline cleanliness (D-08), case-asymmetric
 *      wire `companyName` byte-for-byte (D-09 omission lock — first
 *      cohort case where slug/wire are equal-byte-length but byte-
 *      distinct via case alone), D-10 omission lock — wire-clean
 *      title pass-through, and D-11 fully-clean department pass-
 *      through.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('MasterclassService — Spec 075 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MasterclassModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MasterclassModule],
      }).compile();
      const service = moduleRef.get(MasterclassService);
      expect(service).toBeInstanceOf(MasterclassService);
      await moduleRef.close();
    });

    it('exports the Site.MASTERCLASS = "masterclass" enum value', () => {
      expect(Site.MASTERCLASS).toBe('masterclass');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MasterclassService();
      const input: ScraperInputDto = {
        siteType: [Site.MASTERCLASS],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const aiml = dto.jobs.find((j) => j.id === 'masterclass-7786068');
      expect(aiml).toBeDefined();
      expect(aiml?.site).toBe(Site.MASTERCLASS);
      // D-09 omission lock with equal-length-case-only wire variant:
      // emitted `companyName === 'MasterClass'` byte-for-byte AND
      // matches wire `company_name` byte-for-byte AND is byte-distinct
      // from the slug `masterclass` AND is exactly the SAME byte
      // length as the slug (locking the equal-length-case-only
      // asymmetry — first cohort observation of this asymmetry shape).
      // Twenty-fifth cohort plugin to omit D-09.
      expect(aiml?.companyName).toBe('MasterClass');
      expect(aiml?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(aiml?.companyName).not.toBe('masterclass');
      expect(aiml?.companyName!.length).toBe('masterclass'.length);
      expect(aiml?.companyName!.toLowerCase()).toBe('masterclass');
      // First-listing title is wire-clean — D-10 omission, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(aiml?.title).toBe('Staff AI / ML Engineer');
      expect(aiml?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(aiml?.title.endsWith(' ')).toBe(false);
      // D-04 lock: variant-2 modern hosted-board apex shape.
      expect(aiml?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/masterclass/jobs/7786068',
      );
      expect(aiml?.jobUrl).toContain('job-boards.greenhouse.io/masterclass/jobs/');
      expect(aiml?.jobUrl).not.toContain('?gh_jid=');
      // Location — Remote-detection picks up `remote` substring
      // case-insensitively.
      expect(aiml?.location?.city).toBe('Remote - United States');
      expect(aiml?.isRemote).toBe(true);
      // D-11 first-listing regression guard: emitted `department`
      // matches wire `departments[0].name === 'Engineering'`
      // byte-for-byte (clean single-token form).
      expect(aiml?.department).toBe('Engineering');
      expect(aiml?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // D-08 regression guard: decode-then-strip pipeline cleanliness.
      expect(aiml?.description).not.toContain('&lt;');
      expect(aiml?.description).not.toContain('&quot;');
      expect(aiml?.description).not.toContain('&amp;');
      expect(aiml?.description).not.toContain('<p>');
      expect(aiml?.description).not.toContain('<div>');
      expect(aiml?.description).not.toContain('<strong>');
      expect(aiml?.description).toContain('MasterClass');
      expect(aiml?.description).toContain('AI / ML Engineer');

      const pmm = dto.jobs.find((j) => j.id === 'masterclass-7575409');
      expect(pmm).toBeDefined();
      // D-10 omission lock — second-listing title is wire-clean too;
      // emitted `title` matches wire `title` byte-for-byte.
      expect(pmm?.title).toBe('Senior Product Marketing Manager');
      expect(pmm?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(pmm?.title.endsWith(' ')).toBe(false);
      expect(pmm?.companyName).toBe('MasterClass');
      expect(pmm?.location?.city).toBe('Hybrid - San Francisco, CA');
      expect(pmm?.isRemote).toBe(false);
      // D-11 second-listing regression guard.
      expect(pmm?.department).toBe('Marketing');
      expect(pmm?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-2 lock for the second listing too.
      expect(pmm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/masterclass/jobs/7575409',
      );
      expect(pmm?.jobUrl).toContain('job-boards.greenhouse.io/masterclass/jobs/');
      expect(pmm?.jobUrl).not.toContain('?gh_jid=');
      expect(pmm?.description).not.toContain('<p>');
      expect(pmm?.description).not.toContain('<strong>');
      expect(pmm?.description).toContain('Marketing');

      // Regression guard: the slug must be `masterclass` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/masterclass/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MasterclassService();
      const input: ScraperInputDto = {
        siteType: [Site.MASTERCLASS],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MasterclassService();
      const result = await service.scrape({
        siteType: [Site.MASTERCLASS],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      // Only the first fixture job has 'Engineer' in its title.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('masterclass-7786068');
      expect(result.jobs[0].title).toBe('Staff AI / ML Engineer');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MasterclassService();
      const result = await service.scrape({
        siteType: [Site.MASTERCLASS],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      // Only the second fixture job has 'Marketing' as its department.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('masterclass-7575409');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MasterclassService();
      const result = await service.scrape({
        siteType: [Site.MASTERCLASS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MasterclassService();
      const result = await service.scrape({
        siteType: [Site.MASTERCLASS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
