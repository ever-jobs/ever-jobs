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

import { N26Module, N26Service } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'n26-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 100 / T04 — `N26Service` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `N26Service` through `N26Module`.
 *   2. `Site.N26 === 'n26'` literal pin.
 *   3. Happy path — variant-27 URL pass-through (bare brand-
 *      domain + locale-region single-segment `/en-eu/` +
 *      `/careers/positions/` + path-id + query-id — first
 *      cohort observation of variant 27); D-09 case-asymmetric
 *      all-caps-letter+digits short wire form `'N26'`; D-10
 *      trailing-pad title trim; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('N26Service — Spec 100 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through N26Module via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [N26Module],
      }).compile();
      const service = moduleRef.get(N26Service);
      expect(service).toBeInstanceOf(N26Service);
      await moduleRef.close();
    });

    it('exports the Site.N26 = "n26" enum value', () => {
      expect(Site.N26).toBe('n26');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const afc = dto.jobs.find((j) => j.id === 'n26-7738776');
      expect(afc).toBeDefined();
      expect(afc?.site).toBe(Site.N26);
      // **D-09 lock — case-asymmetric all-caps-letter + digits
      // short wire form**: emitted `companyName === 'N26'`
      // byte-for-byte (3 bytes); case-distinct from slug `n26`
      // on the letter only (`'N'` vs `'n'`); digits are byte-
      // identical.
      expect(afc?.companyName).toBe('N26');
      expect(afc?.companyName?.length).toBe(3);
      expect(afc?.companyName?.toLowerCase()).toBe('n26');
      expect(afc?.companyName).not.toBe(afc?.companyName?.toLowerCase());
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AFC Associate - SAR Delegate ');
      expect(afc?.title).toBe('AFC Associate - SAR Delegate');
      expect(afc?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(afc?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 27 (bare brand-domain locale-
      // region-segment `/careers/positions/` path-id + query-
      // id)**: emitted `jobUrl` byte-for-byte; contains
      // `n26.com/en-eu/careers/positions/`; contains `?gh_jid=`;
      // does NOT contain `job-boards.greenhouse.io` (locks
      // variant-27 against fallback to variant 2); does NOT
      // contain `www.` (locks bare-brand-domain sub-axis vs
      // variants 16/19/20/24/25); does NOT contain `careers.`
      // (locks bare-brand-domain sub-axis vs variants 8/21/26).
      expect(afc?.jobUrl).toBe(
        'https://n26.com/en-eu/careers/positions/7738776?gh_jid=7738776',
      );
      expect(afc?.jobUrl).toContain('n26.com/en-eu/careers/positions/');
      expect(afc?.jobUrl).toContain('?gh_jid=7738776');
      expect(afc?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(afc?.jobUrl).not.toContain('www.');
      expect(afc?.jobUrl).not.toContain('careers.');
      expect(afc?.department).toBe('Banking Operations');
      expect(afc?.location?.city).toBe('Paris');
      expect(afc?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(afc?.description).not.toContain('&lt;');
      expect(afc?.description).not.toContain('&amp;');
      expect(afc?.description).not.toContain('<p>');
      expect(afc?.description).not.toContain('<strong>');
      expect(afc?.description).toContain('N26');

      const audit = dto.jobs.find((j) => j.id === 'n26-7811338');
      expect(audit).toBeDefined();
      expect(audit?.title).toBe('Group Internal Audit Manager');
      expect(audit?.companyName).toBe('N26');
      expect(audit?.location?.city).toBe('Berlin');
      expect(audit?.isRemote).toBe(false);
      expect(audit?.department).toBe('Group Internal Audit');
      expect(audit?.jobUrl).toBe(
        'https://n26.com/en-eu/careers/positions/7811338?gh_jid=7811338',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/n26/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
        searchTerm: 'AUDIT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('n26-7811338');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
        searchTerm: 'banking',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('n26-7738776');
      expect(result.jobs[0].department).toBe('Banking Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new N26Service();
      const result = await service.scrape({
        siteType: [Site.N26],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
