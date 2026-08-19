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

import { AdyenModule, AdyenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'adyen-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 090 / T04 — `AdyenService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AdyenService` through `AdyenModule`.
 *   2. `Site.ADYEN === 'adyen'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive, trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department (case-insensitive).
 *   7. HTTP 500 → `{ jobs: [] }`.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('AdyenService — Spec 090 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AdyenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AdyenModule],
      }).compile();
      const service = moduleRef.get(AdyenService);
      expect(service).toBeInstanceOf(AdyenService);
      await moduleRef.close();
    });

    it('exports the Site.ADYEN = "adyen" enum value', () => {
      expect(Site.ADYEN).toBe('adyen');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const am = dto.jobs.find((j) => j.id === 'adyen-7340050');
      expect(am).toBeDefined();
      expect(am?.site).toBe(Site.ADYEN);
      // D-09 omission lock: case-symmetric wire `'Adyen'`.
      expect(am?.companyName).toBe('Adyen');
      expect(am?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(am?.companyName?.toLowerCase()).toBe('adyen');
      // First-listing title clean — D-10 trim no-op.
      expect(am?.title).toBe('Account Manager');
      expect(am?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant 2.
      expect(am?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/adyen/jobs/7340050',
      );
      expect(am?.jobUrl).toContain('job-boards.greenhouse.io/adyen/jobs/');
      expect(am?.jobUrl).not.toContain('?gh_jid=');
      // First-listing dept clean — D-11 omitted.
      expect(am?.department).toBe('Account Management');
      expect(am?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(am?.location?.city).toBe('Amsterdam, Netherlands');
      expect(am?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(am?.description).not.toContain('&lt;');
      expect(am?.description).not.toContain('&amp;');
      expect(am?.description).not.toContain('&#8217;');
      expect(am?.description).not.toContain('<p>');
      expect(am?.description).not.toContain('<strong>');
      expect(am?.description).toContain('Adyen');

      const eng = dto.jobs.find((j) => j.id === 'adyen-7436701');
      expect(eng).toBeDefined();
      // D-10 application lock — single-trailing-pad form.
      expect(eng?.title).toBe('Senior Software Engineer');
      expect(eng?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Software Engineer ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(eng?.title.endsWith(' ')).toBe(false);
      expect(eng?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(eng?.companyName).toBe('Adyen');
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.isRemote).toBe(false);
      expect(eng?.department).toBe('Infrastructure');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/adyen/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      // 'Engineer' only in second listing's title.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('adyen-7436701');
      expect(result.jobs[0].title).toBe('Senior Software Engineer');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
        searchTerm: 'account',
      } as ScraperInputDto);

      // 'Account' only in first listing (title 'Account Manager'
      // and dept 'Account Management').
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('adyen-7340050');
      expect(result.jobs[0].department).toBe('Account Management');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AdyenService();
      const result = await service.scrape({
        siteType: [Site.ADYEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
