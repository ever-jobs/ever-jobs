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

import { FastlyModule, FastlyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'fastly-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 113 / T04 — `FastlyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FastlyService` through `FastlyModule`.
 *   2. `Site.FASTLY === 'fastly'` literal pin.
 *   3. Happy path — variant-30 URL pass-through (first cohort
 *      observation of HTTPS `/about/jobs/apply` query-only-id);
 *      D-09 case-symmetric lock; D-10 trailing-pad title trim;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('FastlyService — Spec 113 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FastlyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FastlyModule],
      }).compile();
      const service = moduleRef.get(FastlyService);
      expect(service).toBeInstanceOf(FastlyService);
      await moduleRef.close();
    });

    it('exports the Site.FASTLY = "fastly" enum value', () => {
      expect(Site.FASTLY).toBe('fastly');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ddm = dto.jobs.find((j) => j.id === 'fastly-7858959');
      expect(ddm).toBeDefined();
      expect(ddm?.site).toBe(Site.FASTLY);
      // D-09 case-symmetric lock.
      expect(ddm?.companyName).toBe('Fastly');
      expect(ddm?.companyName?.toLowerCase()).toBe('fastly');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Deal Desk Manager ');
      expect(ddm?.title).toBe('Deal Desk Manager');
      expect(ddm?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 30 (first cohort observation of
      // HTTPS `/about/jobs/apply` query-only-id).**
      expect(ddm?.jobUrl).toBe(
        'https://www.fastly.com/about/jobs/apply?gh_jid=7858959',
      );
      expect(ddm?.jobUrl).toMatch(/^https:\/\//);
      expect(ddm?.jobUrl).toContain('www.fastly.com/about/jobs/apply');
      expect(ddm?.jobUrl).toContain('?gh_jid=7858959');
      expect(ddm?.jobUrl).not.toContain('greenhouse.io');
      expect(ddm?.department).toBe('CFO');
      expect(ddm?.location?.city).toBe('San Francisco, CA');
      expect(ddm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ddm?.description).not.toContain('&lt;');
      expect(ddm?.description).not.toContain('&amp;');
      expect(ddm?.description).not.toContain('<p>');
      expect(ddm?.description).not.toContain('<strong>');
      expect(ddm?.description).toContain('Fastly');

      const csoc = dto.jobs.find((j) => j.id === 'fastly-7641773');
      expect(csoc).toBeDefined();
      expect(csoc?.title).toBe('CSOC Engineer - Security Automation');
      expect(csoc?.companyName).toBe('Fastly');
      expect(csoc?.location?.city).toBe('Pune,  India');
      expect(csoc?.isRemote).toBe(false);
      expect(csoc?.department).toBe('Customer Security - CSOC');
      expect(csoc?.jobUrl).toBe(
        'https://www.fastly.com/about/jobs/apply?gh_jid=7641773',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/fastly/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
        searchTerm: 'CSOC',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fastly-7641773');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
        searchTerm: 'cfo',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('fastly-7858959');
      expect(result.jobs[0].department).toBe('CFO');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FastlyService();
      const result = await service.scrape({
        siteType: [Site.FASTLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
