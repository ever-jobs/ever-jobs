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

import { DescriptModule, DescriptService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'descript-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 112 / T04 — `DescriptService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DescriptService` through `DescriptModule`.
 *   2. `Site.DESCRIPT === 'descript'` literal pin.
 *   3. Happy path — variant-10 URL pass-through (legacy hosted-
 *      board apex); D-09 case-symmetric lock; D-10 trailing-pad
 *      title trim; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DescriptService — Spec 112 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DescriptModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DescriptModule],
      }).compile();
      const service = moduleRef.get(DescriptService);
      expect(service).toBeInstanceOf(DescriptService);
      await moduleRef.close();
    });

    it('exports the Site.DESCRIPT = "descript" enum value', () => {
      expect(Site.DESCRIPT).toBe('descript');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'descript-7633072003');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.DESCRIPT);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Descript');
      expect(ae?.companyName?.toLowerCase()).toBe('descript');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive ');
      expect(ae?.title).toBe('Account Executive');
      expect(ae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 10 (legacy hosted-board apex).
      expect(ae?.jobUrl).toBe(
        'https://boards.greenhouse.io/descript/jobs/7633072003?gh_jid=7633072003',
      );
      expect(ae?.jobUrl).toContain('boards.greenhouse.io/descript/jobs/');
      expect(ae?.jobUrl).toContain('?gh_jid=7633072003');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ae?.department).toBe('Sales & Business Development');
      expect(ae?.location?.city).toBe('San Francisco, CA or Remote, US');
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Descript');

      const sse = dto.jobs.find((j) => j.id === 'descript-7676250003');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Audio');
      expect(sse?.companyName).toBe('Descript');
      expect(sse?.location?.city).toBe('San Francisco, CA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://boards.greenhouse.io/descript/jobs/7676250003?gh_jid=7676250003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/descript/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
        searchTerm: 'AUDIO',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('descript-7676250003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
        searchTerm: 'business development',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('descript-7633072003');
      expect(result.jobs[0].department).toBe('Sales & Business Development');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DescriptService();
      const result = await service.scrape({
        siteType: [Site.DESCRIPT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
