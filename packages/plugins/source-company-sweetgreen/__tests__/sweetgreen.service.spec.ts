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

import { SweetgreenModule, SweetgreenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'sweetgreen-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 104 / T04 — `SweetgreenService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SweetgreenService` through `SweetgreenModule`.
 *   2. `Site.SWEETGREEN === 'sweetgreen'` literal pin.
 *   3. Happy path — variant-29 URL pass-through (careers-
 *      subdomain root-level `/jobs/` path-id + query-id —
 *      first cohort observation of variant 29); D-09 APPLIED
 *      with leading-space pad sub-axis (first cohort observation;
 *      wire ` sweetgreen` 11 bytes → trim → `sweetgreen` 10
 *      bytes); D-10 trailing-pad title trim; D-11 clean store-
 *      location dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('SweetgreenService — Spec 104 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SweetgreenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SweetgreenModule],
      }).compile();
      const service = moduleRef.get(SweetgreenService);
      expect(service).toBeInstanceOf(SweetgreenService);
      await moduleRef.close();
    });

    it('exports the Site.SWEETGREEN = "sweetgreen" enum value', () => {
      expect(Site.SWEETGREEN).toBe('sweetgreen');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const al = dto.jobs.find((j) => j.id === 'sweetgreen-7832157');
      expect(al).toBeDefined();
      expect(al?.site).toBe(Site.SWEETGREEN);
      // **D-09 lock — APPLIED with leading-space pad sub-axis
      // (first cohort observation)**: wire ` sweetgreen` (11
      // bytes, leading space) trimmed → emitted `'sweetgreen'`
      // (10 bytes, no leading whitespace).
      expect(JOBS_PAGE_RAW.jobs[0].company_name).toBe(' sweetgreen');
      expect(JOBS_PAGE_RAW.jobs[0].company_name.length).toBe(11);
      expect(JOBS_PAGE_RAW.jobs[0].company_name.charCodeAt(0)).toBe(32); // ' '
      expect(al?.companyName).toBe('sweetgreen');
      expect(al?.companyName?.length).toBe(10);
      expect(al?.companyName).not.toMatch(/^\s/);
      expect(al?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(al?.title).toBe('Area Leader');
      // **D-04 lock — variant 29 (careers-subdomain root-level
      // `/jobs/` path-id + query-id)**: emitted `jobUrl` byte-
      // for-byte; contains `careers.sweetgreen.com/jobs/`;
      // contains `?gh_jid=`; does NOT contain `job-boards.
      // greenhouse.io` (locks variant-29 against fallback to
      // variant 2); does NOT contain `/global/` (locks no-
      // locale-prefix sub-axis vs variant 26); does NOT contain
      // `/careers/` (locks root-level `/jobs/` sub-axis vs
      // variant 13's `/careers/jobs/<id>`).
      expect(al?.jobUrl).toBe(
        'https://careers.sweetgreen.com/jobs/7832157?gh_jid=7832157',
      );
      expect(al?.jobUrl).toContain('careers.sweetgreen.com/jobs/');
      expect(al?.jobUrl).toContain('?gh_jid=7832157');
      expect(al?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(al?.jobUrl).not.toContain('/global/');
      expect(al?.jobUrl).not.toContain('/careers/jobs/');
      // D-11 omitted (clean store-location dept).
      expect(al?.department).toBe('Back Bay');
      expect(al?.location?.city).toBe('Boston, MA');
      expect(al?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(al?.description).not.toContain('&lt;');
      expect(al?.description).not.toContain('&amp;');
      expect(al?.description).not.toContain('<p>');
      expect(al?.description).not.toContain('<strong>');
      expect(al?.description).toContain('sweetgreen');

      const fmm = dto.jobs.find((j) => j.id === 'sweetgreen-7723372');
      expect(fmm).toBeDefined();
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Field Marketing Manager ');
      expect(fmm?.title).toBe('Field Marketing Manager');
      expect(fmm?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(fmm?.title).not.toMatch(/\s$/);
      expect(fmm?.companyName).toBe('sweetgreen');
      expect(fmm?.location?.city).toBe('Los Angeles, CA');
      expect(fmm?.isRemote).toBe(false);
      // D-11 store-location dept lock.
      expect(fmm?.department).toBe('16th + Market');
      expect(fmm?.jobUrl).toBe(
        'https://careers.sweetgreen.com/jobs/7723372?gh_jid=7723372',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/sweetgreen/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
        searchTerm: 'MARKETING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sweetgreen-7723372');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
        searchTerm: 'back bay',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sweetgreen-7832157');
      expect(result.jobs[0].department).toBe('Back Bay');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SweetgreenService();
      const result = await service.scrape({
        siteType: [Site.SWEETGREEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
