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

import { CollectiveHealthModule, CollectiveHealthService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'collectivehealth-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 155 / T04 — `CollectiveHealthService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CollectiveHealthService` through `CollectiveHealthModule`.
 *   2. `Site.COLLECTIVEHEALTH === 'collectivehealth'` literal pin.
 *   3. Happy path — **variant-42 URL byte-for-byte lock**
 *      (`jobs.collectivehealth.com/apply/?gh_jid=<id>` `jobs.`
 *      subdomain `/apply/` query-only-id form); D-09
 *      internal-whitespace asymmetric wire pin (`'Collective
 *      Health'` 17 bytes / 16-byte slug); D-10 omitted byte-
 *      for-byte title pass-through (no trim) lock; D-11
 *      clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CollectiveHealthService — Spec 155 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CollectiveHealthModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CollectiveHealthModule],
      }).compile();
      const service = moduleRef.get(CollectiveHealthService);
      expect(service).toBeInstanceOf(CollectiveHealthService);
      await moduleRef.close();
    });

    it('exports the Site.COLLECTIVEHEALTH = "collectivehealth" enum value', () => {
      expect(Site.COLLECTIVEHEALTH).toBe('collectivehealth');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csr = dto.jobs.find((j) => j.id === 'collectivehealth-7872568');
      expect(csr).toBeDefined();
      expect(csr?.site).toBe(Site.COLLECTIVEHEALTH);
      // D-09 internal-whitespace asymmetric lock — wire is
      // 'Collective Health' (17 bytes, two-token); slug is
      // 'collectivehealth' (16 bytes, concatenated lowercase).
      expect(csr?.companyName).toBe('Collective Health');
      expect(csr?.companyName?.length).toBe(17);
      expect(csr?.companyName?.replace(' ', '').toLowerCase()).toBe('collectivehealth');
      expect(csr?.title).toBe('Customer Service Representative (6-month Contract)');
      // D-04 lock — variant 42 (`jobs.` subdomain `/apply/`
      // query-only-id form).
      expect(csr?.jobUrl).toBe(
        'https://jobs.collectivehealth.com/apply/?gh_jid=7872568',
      );
      expect(csr?.jobUrl).toContain('jobs.collectivehealth.com/apply/');
      expect(csr?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(csr?.department).toBe('Health Plan Operations');
      expect(csr?.location?.city).toBe('Lehi, UT');
      expect(csr?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(csr?.description).not.toContain('&lt;');
      expect(csr?.description).not.toContain('<p>');
      expect(csr?.description).toContain('Collective Health');

      const sse = dto.jobs.find((j) => j.id === 'collectivehealth-7760151');
      expect(sse).toBeDefined();
      // D-10 omitted — title byte-for-byte pass-through.
      expect(sse?.title).toBe('Senior Software Engineer');
      expect(sse?.companyName).toBe('Collective Health');
      expect(sse?.location?.city).toBe('San Francisco, CA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://jobs.collectivehealth.com/apply/?gh_jid=7760151',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/collectivehealth/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
        searchTerm: 'CUSTOMER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('collectivehealth-7872568');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('collectivehealth-7760151');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CollectiveHealthService();
      const result = await service.scrape({
        siteType: [Site.COLLECTIVEHEALTH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
