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

import { SoFiModule, SoFiService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'sofi-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 102 / T04 — `SoFiService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SoFiService` through `SoFiModule`.
 *   2. `Site.SOFI === 'sofi'` literal pin.
 *   3. Happy path — variant-28 URL pass-through (bare brand-
 *      domain `/careers/job/` path-id + query-id — first cohort
 *      observation of variant 28); D-09 PascalCase TWO-internal-
 *      cap same-byte-count case-asymmetric wire `'SoFi'`; D-10
 *      trailing-pad title trim; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('SoFiService — Spec 102 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SoFiModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SoFiModule],
      }).compile();
      const service = moduleRef.get(SoFiService);
      expect(service).toBeInstanceOf(SoFiService);
      await moduleRef.close();
    });

    it('exports the Site.SOFI = "sofi" enum value', () => {
      expect(Site.SOFI).toBe('sofi');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const apm = dto.jobs.find((j) => j.id === 'sofi-7668357003');
      expect(apm).toBeDefined();
      expect(apm?.site).toBe(Site.SOFI);
      // **D-09 lock — FIRST-COHORT PascalCase TWO-internal-cap
      // same-byte-count case-asymmetric wire form**: emitted
      // `companyName === 'SoFi'` byte-for-byte (4 bytes); same
      // byte-count as slug `sofi` (4 bytes) but byte-distinct
      // via case at TWO indices — `'S'` vs `'s'` at index 0
      // AND `'F'` vs `'f'` at index 2.
      expect(apm?.companyName).toBe('SoFi');
      expect(apm?.companyName?.length).toBe(4);
      expect(apm?.companyName?.toLowerCase()).toBe('sofi');
      expect(apm?.companyName?.charCodeAt(0)).toBe(83); // 'S'
      expect(apm?.companyName?.charCodeAt(2)).toBe(70); // 'F'
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Accounting Policy Manager ');
      expect(apm?.title).toBe('Accounting Policy Manager');
      expect(apm?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(apm?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 28 (bare brand-domain
      // `/careers/job/` path-id + query-id)**: emitted `jobUrl`
      // byte-for-byte; contains `sofi.com/careers/job/`;
      // contains `?gh_jid=`; does NOT contain
      // `job-boards.greenhouse.io` (locks variant-28 against
      // fallback to variant 2); does NOT contain `www.` (locks
      // bare-brand-domain sub-axis vs variant 19's `www.
      // klaviyo.com/careers/job/` shape).
      expect(apm?.jobUrl).toBe(
        'https://sofi.com/careers/job/7668357003?gh_jid=7668357003',
      );
      expect(apm?.jobUrl).toContain('sofi.com/careers/job/');
      expect(apm?.jobUrl).toContain('?gh_jid=7668357003');
      expect(apm?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(apm?.jobUrl).not.toContain('www.');
      expect(apm?.department).toBe('Accounting');
      expect(apm?.location?.city).toContain('New York City');
      expect(apm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(apm?.description).not.toContain('&lt;');
      expect(apm?.description).not.toContain('&amp;');
      expect(apm?.description).not.toContain('<p>');
      expect(apm?.description).not.toContain('<strong>');
      expect(apm?.description).toContain('SoFi');

      const cma = dto.jobs.find((j) => j.id === 'sofi-7710361003');
      expect(cma).toBeDefined();
      expect(cma?.title).toBe('Senior Capital Markets Analyst');
      expect(cma?.companyName).toBe('SoFi');
      expect(cma?.location?.city).toBe('Frisco - TX');
      expect(cma?.isRemote).toBe(false);
      expect(cma?.department).toBe('Capital Markets');
      expect(cma?.jobUrl).toBe(
        'https://sofi.com/careers/job/7710361003?gh_jid=7710361003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/sofi/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
        searchTerm: 'CAPITAL',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sofi-7710361003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
        searchTerm: 'accounting',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sofi-7668357003');
      expect(result.jobs[0].department).toBe('Accounting');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SoFiService();
      const result = await service.scrape({
        siteType: [Site.SOFI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
