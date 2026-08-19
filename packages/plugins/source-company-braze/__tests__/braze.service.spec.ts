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

import { BrazeModule, BrazeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'braze-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 110 / T04 — `BrazeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BrazeService` through `BrazeModule`.
 *   2. `Site.BRAZE === 'braze'` literal pin.
 *   3. Happy path — variant-10 URL pass-through (legacy hosted-
 *      board apex `boards.greenhouse.io`); D-09 case-symmetric
 *      lock; D-10 trailing-pad title trim; D-11 clean dept
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BrazeService — Spec 110 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BrazeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BrazeModule],
      }).compile();
      const service = moduleRef.get(BrazeService);
      expect(service).toBeInstanceOf(BrazeService);
      await moduleRef.close();
    });

    it('exports the Site.BRAZE = "braze" enum value', () => {
      expect(Site.BRAZE).toBe('braze');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'braze-7793490');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.BRAZE);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Braze');
      expect(ae?.companyName?.toLowerCase()).toBe('braze');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive, Central America LATAM ');
      expect(ae?.title).toBe('Account Executive, Central America LATAM');
      expect(ae?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ae?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 10 (legacy hosted-board apex
      // `boards.greenhouse.io`)**: emitted `jobUrl` byte-for-
      // byte; contains `boards.greenhouse.io/braze/jobs/`;
      // contains `?gh_jid=`; does NOT contain
      // `job-boards.greenhouse.io` (locks variant-10 against
      // canonical variant-2 host).
      expect(ae?.jobUrl).toBe(
        'https://boards.greenhouse.io/braze/jobs/7793490?gh_jid=7793490',
      );
      expect(ae?.jobUrl).toContain('boards.greenhouse.io/braze/jobs/');
      expect(ae?.jobUrl).toContain('?gh_jid=7793490');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ae?.department).toBe('Growth');
      expect(ae?.location?.city).toBe('Mexico City');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Braze');

      const sse = dto.jobs.find((j) => j.id === 'braze-7800342');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      expect(sse?.companyName).toBe('Braze');
      expect(sse?.location?.city).toBe('New York, NY');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://boards.greenhouse.io/braze/jobs/7800342?gh_jid=7800342',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/braze/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
        searchTerm: 'PLATFORM',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('braze-7800342');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
        searchTerm: 'growth',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('braze-7793490');
      expect(result.jobs[0].department).toBe('Growth');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BrazeService();
      const result = await service.scrape({
        siteType: [Site.BRAZE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
