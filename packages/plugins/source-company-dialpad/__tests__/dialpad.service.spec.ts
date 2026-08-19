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

import { DialpadModule, DialpadService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'dialpad-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 126 / T04 — `DialpadService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DialpadService` through `DialpadModule`.
 *   2. `Site.DIALPAD === 'dialpad'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Dialpad'` lock; D-10 byte-for-byte title
 *      pass-through (no trim) lock; **D-11 first-cohort
 *      numeric-prefix-with-hyphen-separator dept naming
 *      pass-through lock** (`'120 - Product Operations'` byte-
 *      for-byte).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DialpadService — Spec 126 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DialpadModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DialpadModule],
      }).compile();
      const service = moduleRef.get(DialpadService);
      expect(service).toBeInstanceOf(DialpadService);
      await moduleRef.close();
    });

    it('exports the Site.DIALPAD = "dialpad" enum value', () => {
      expect(Site.DIALPAD).toBe('dialpad');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const aie = dto.jobs.find((j) => j.id === 'dialpad-8367059002');
      expect(aie).toBeDefined();
      expect(aie?.site).toBe(Site.DIALPAD);
      // D-09 case-symmetric lock.
      expect(aie?.companyName).toBe('Dialpad');
      expect(aie?.companyName?.toLowerCase()).toBe('dialpad');
      // D-10 lock — wire title is clean; emitted byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AI Engineer, Real-Time Voice');
      expect(aie?.title).toBe('AI Engineer, Real-Time Voice');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(aie?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/dialpad/jobs/8367059002',
      );
      expect(aie?.jobUrl).toContain('job-boards.greenhouse.io/dialpad/jobs/');
      // **D-11 lock — first-cohort numeric-prefix-with-hyphen-
      // separator dept naming convention**: emitted department
      // `'214 - AI Engineering'` byte-for-byte (numeric code +
      // ` - ` separator + name).
      expect(aie?.department).toBe('214 - AI Engineering');
      expect(aie?.department).toMatch(/^\d+ - /);
      expect(aie?.location?.city).toBe('San Francisco, CA');
      expect(aie?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(aie?.description).not.toContain('&lt;');
      expect(aie?.description).not.toContain('&amp;');
      expect(aie?.description).not.toContain('<p>');
      expect(aie?.description).not.toContain('<strong>');
      expect(aie?.description).toContain('Dialpad');

      const pom = dto.jobs.find((j) => j.id === 'dialpad-8492137003');
      expect(pom).toBeDefined();
      expect(pom?.title).toBe('Product Operations Manager');
      expect(pom?.companyName).toBe('Dialpad');
      expect(pom?.location?.city).toBe('Vancouver, BC, Canada');
      expect(pom?.isRemote).toBe(false);
      // **D-11 lock — second sample**: numeric-prefix-with-
      // hyphen pass-through preserved byte-for-byte.
      expect(pom?.department).toBe('120 - Product Operations');
      expect(pom?.department).toMatch(/^\d+ - /);
      expect(pom?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/dialpad/jobs/8492137003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/dialpad/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
        searchTerm: 'voice',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dialpad-8367059002');
    });

    it('filters by case-insensitive substring of department name (incl. numeric prefix)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
        searchTerm: 'product operations',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dialpad-8492137003');
      expect(result.jobs[0].department).toBe('120 - Product Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DialpadService();
      const result = await service.scrape({
        siteType: [Site.DIALPAD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
