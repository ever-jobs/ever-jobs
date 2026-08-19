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

import { SymphonyModule, SymphonyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'symphony-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 172 / T04 — `SymphonyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SymphonyService` through `SymphonyModule`.
 *   2. `Site.SYMPHONY === 'symphony'` literal pin.
 *   3. Happy path — **NEW variant-45 vanity-domain URL byte-
 *      for-byte lock** (`https://symphony.com/company/apply?gh_jid=<id>`);
 *      D-09 fifth-cohort slug-truncation multi-token corp-
 *      suffix wire pin (`'Symphony Communication Services'`
 *      31 bytes; slug `symphony` 8 bytes — first wire token
 *      only); D-10 OMITTED title byte-for-byte pass-through;
 *      D-11 trailing-pad dept-trim lock.
 *   4..8. variant-2 fallback, resultsWanted, searchTerm
 *      filters, error handling, empty payload.
 */
describe('SymphonyService — Spec 172 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SymphonyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SymphonyModule],
      }).compile();
      const service = moduleRef.get(SymphonyService);
      expect(service).toBeInstanceOf(SymphonyService);
      await moduleRef.close();
    });

    it('exports the Site.SYMPHONY = "symphony" enum value', () => {
      expect(Site.SYMPHONY).toBe('symphony');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csm = dto.jobs.find((j) => j.id === 'symphony-7278850');
      expect(csm).toBeDefined();
      expect(csm?.site).toBe(Site.SYMPHONY);
      // D-09 slug-truncation multi-token corp-suffix wire lock.
      expect(csm?.companyName).toBe('Symphony Communication Services');
      expect(csm?.companyName?.toLowerCase().split(' ')[0]).toBe('symphony');
      expect(csm?.companyName?.length).toBe(31);
      // D-10 OMITTED — wire title pass-through byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Senior Customer Success Manager');
      expect(csm?.title).toBe('Senior Customer Success Manager');
      // D-04 NEW variant-45 vanity-domain URL byte-for-byte lock.
      expect(csm?.jobUrl).toBe('https://symphony.com/company/apply?gh_jid=7278850');
      expect(csm?.jobUrl).toContain('symphony.com/company/apply?gh_jid=');
      expect(csm?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // D-11 APPLIED trailing-pad dept-trim lock.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Customer Experience ');
      expect(csm?.department).toBe('Customer Experience');
      expect(csm?.department).not.toMatch(/\s$/);
      expect(csm?.location?.city).toBe('New York, NY');
      expect(csm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(csm?.description).not.toContain('&lt;');
      expect(csm?.description).not.toContain('&amp;');
      expect(csm?.description).not.toContain('<p>');
      expect(csm?.description).toContain('Symphony');

      const sse = dto.jobs.find((j) => j.id === 'symphony-7795710');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Staff Software Engineer');
      expect(sse?.companyName).toBe('Symphony Communication Services');
      expect(sse?.location?.city).toBe('Sophia Antipolis, Remote');
      expect(sse?.isRemote).toBe(true);
      // D-11 clean dept pass-through (no padding on this row).
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe('https://symphony.com/company/apply?gh_jid=7795710');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/symphony/jobs?content=true',
      );
    });
  });

  describe('variant-2 fallback URL', () => {
    it('synthesises a canonical Greenhouse URL when wire absolute_url is absent', async () => {
      const payload = clone(JOBS_PAGE_RAW);
      delete payload.jobs[0].absolute_url;
      mockGet.mockResolvedValueOnce({ data: payload });

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
      } as ScraperInputDto);
      const csm = result.jobs.find((j) => j.id === 'symphony-7278850');
      expect(csm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/symphony/jobs/7278850',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
        searchTerm: 'SOFTWARE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('symphony-7795710');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SymphonyService();
      const result = await service.scrape({
        siteType: [Site.SYMPHONY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
