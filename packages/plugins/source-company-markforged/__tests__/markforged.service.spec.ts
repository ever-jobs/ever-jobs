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

import { MarkforgedModule, MarkforgedService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'markforged-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 161 / T04 — `MarkforgedService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MarkforgedService` through `MarkforgedModule`.
 *   2. `Site.MARKFORGED === 'markforged'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Markforged'` lock; D-10 clean title pass-
 *      through; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('MarkforgedService — Spec 161 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MarkforgedModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MarkforgedModule],
      }).compile();
      const service = moduleRef.get(MarkforgedService);
      expect(service).toBeInstanceOf(MarkforgedService);
      await moduleRef.close();
    });

    it('exports the Site.MARKFORGED = "markforged" enum value', () => {
      expect(Site.MARKFORGED).toBe('markforged');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'markforged-5798729004');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.MARKFORGED);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Markforged');
      expect(ae?.companyName?.toLowerCase()).toBe('markforged');
      // D-10 omitted lock — wire title is clean.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Application Engineer');
      expect(ae?.title).toBe('Application Engineer');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/markforged/jobs/5798729004',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/markforged/jobs/');
      // D-11 clean dept pass-through.
      expect(ae?.department).toBe('Application Engineering');
      expect(ae?.location?.city).toBe('Watertown, MA');
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Markforged');

      const dhe = dto.jobs.find((j) => j.id === 'markforged-5817888004');
      expect(dhe).toBeDefined();
      expect(dhe?.title).toBe('Director of Hardware Engineering');
      expect(dhe?.companyName).toBe('Markforged');
      expect(dhe?.location?.city).toBe('Remote, US');
      expect(dhe?.isRemote).toBe(true);
      expect(dhe?.department).toBe('Engineering');
      expect(dhe?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/markforged/jobs/5817888004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/markforged/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
        searchTerm: 'DIRECTOR',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('markforged-5817888004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
        searchTerm: 'application',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('markforged-5798729004');
      expect(result.jobs[0].department).toBe('Application Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MarkforgedService();
      const result = await service.scrape({
        siteType: [Site.MARKFORGED],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
