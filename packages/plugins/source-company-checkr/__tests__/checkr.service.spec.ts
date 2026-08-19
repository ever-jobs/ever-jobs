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

import { CheckrModule, CheckrService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'checkr-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 123 / T04 — `CheckrService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CheckrService` through `CheckrModule`.
 *   2. `Site.CHECKR === 'checkr'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Checkr'` lock; D-10 trailing-pad title trim;
 *      D-11 clean dept pass-through (incl. `'CheckrX'`
 *      embedded-brand sub-axis observation).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CheckrService — Spec 123 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CheckrModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CheckrModule],
      }).compile();
      const service = moduleRef.get(CheckrService);
      expect(service).toBeInstanceOf(CheckrService);
      await moduleRef.close();
    });

    it('exports the Site.CHECKR = "checkr" enum value', () => {
      expect(Site.CHECKR).toBe('checkr');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const im = dto.jobs.find((j) => j.id === 'checkr-7782659');
      expect(im).toBeDefined();
      expect(im?.site).toBe(Site.CHECKR);
      // D-09 case-symmetric lock.
      expect(im?.companyName).toBe('Checkr');
      expect(im?.companyName?.toLowerCase()).toBe('checkr');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Implementation Manager, Customer Success ');
      expect(im?.title).toBe('Implementation Manager, Customer Success');
      expect(im?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(im?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/checkr/jobs/7782659',
      );
      expect(im?.jobUrl).toContain('job-boards.greenhouse.io/checkr/jobs/');
      expect(im?.department).toBe('Implementations');
      expect(im?.location?.city).toBe('Remote, US');
      expect(im?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(im?.description).not.toContain('&lt;');
      expect(im?.description).not.toContain('&amp;');
      expect(im?.description).not.toContain('<p>');
      expect(im?.description).not.toContain('<strong>');
      expect(im?.description).toContain('Checkr');

      const spe = dto.jobs.find((j) => j.id === 'checkr-7895432');
      expect(spe).toBeDefined();
      // D-10 lock — second trailing-pad sample; emitted trim.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Python Engineer, Truework ');
      expect(spe?.title).toBe('Senior Python Engineer, Truework');
      expect(spe?.companyName).toBe('Checkr');
      expect(spe?.location?.city).toBe('San Francisco, CA');
      expect(spe?.isRemote).toBe(false);
      // D-11 sub-axis observation — embedded-brand dept name.
      expect(spe?.department).toBe('CheckrX');
      expect(spe?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/checkr/jobs/7895432',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/checkr/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
        searchTerm: 'PYTHON',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('checkr-7895432');
    });

    it('filters by case-insensitive substring of department name (incl. embedded-brand `CheckrX`)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
        searchTerm: 'checkrx',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('checkr-7895432');
      expect(result.jobs[0].department).toBe('CheckrX');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CheckrService();
      const result = await service.scrape({
        siteType: [Site.CHECKR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
