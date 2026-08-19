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

import { BranchModule, BranchService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'branch-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 121 / T04 — `BranchService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BranchService` through `BranchModule`.
 *   2. `Site.BRANCH === 'branch'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Branch'` lock; D-10 byte-for-byte title
 *      pass-through (no trim) lock; D-11 clean dept pass-
 *      through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BranchService — Spec 121 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BranchModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BranchModule],
      }).compile();
      const service = moduleRef.get(BranchService);
      expect(service).toBeInstanceOf(BranchService);
      await moduleRef.close();
    });

    it('exports the Site.BRANCH = "branch" enum value', () => {
      expect(Site.BRANCH).toBe('branch');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sse = dto.jobs.find((j) => j.id === 'branch-7689620003');
      expect(sse).toBeDefined();
      expect(sse?.site).toBe(Site.BRANCH);
      // D-09 case-symmetric lock.
      expect(sse?.companyName).toBe('Branch');
      expect(sse?.companyName?.toLowerCase()).toBe('branch');
      // D-10 lock — wire title is clean; emitted byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Senior Software Engineer, Platform');
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/branch/jobs/7689620003',
      );
      expect(sse?.jobUrl).toContain('job-boards.greenhouse.io/branch/jobs/');
      expect(sse?.department).toBe('Engineering');
      expect(sse?.location?.city).toBe('Palo Alto, CA');
      expect(sse?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(sse?.description).not.toContain('&lt;');
      expect(sse?.description).not.toContain('&amp;');
      expect(sse?.description).not.toContain('<p>');
      expect(sse?.description).not.toContain('<strong>');
      expect(sse?.description).toContain('Branch');

      const sec = dto.jobs.find((j) => j.id === 'branch-7754201002');
      expect(sec).toBeDefined();
      expect(sec?.title).toBe('Senior Application Security Engineer');
      expect(sec?.companyName).toBe('Branch');
      expect(sec?.location?.city).toBe('Remote, US');
      expect(sec?.isRemote).toBe(true);
      expect(sec?.department).toBe('Security');
      expect(sec?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/branch/jobs/7754201002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/branch/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
        searchTerm: 'PLATFORM',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('branch-7689620003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
        searchTerm: 'security',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('branch-7754201002');
      expect(result.jobs[0].department).toBe('Security');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BranchService();
      const result = await service.scrape({
        siteType: [Site.BRANCH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
