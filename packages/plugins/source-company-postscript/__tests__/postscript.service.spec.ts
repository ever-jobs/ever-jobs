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

import { PostscriptModule, PostscriptService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'postscript-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 164 / T04 — `PostscriptService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `PostscriptService` through `PostscriptModule`.
 *   2. `Site.POSTSCRIPT === 'postscript'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Postscript'` lock; D-10 trailing-pad
 *      title-trim lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('PostscriptService — Spec 164 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through PostscriptModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PostscriptModule],
      }).compile();
      const service = moduleRef.get(PostscriptService);
      expect(service).toBeInstanceOf(PostscriptService);
      await moduleRef.close();
    });

    it('exports the Site.POSTSCRIPT = "postscript" enum value', () => {
      expect(Site.POSTSCRIPT).toBe('postscript');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csm = dto.jobs.find((j) => j.id === 'postscript-8531822002');
      expect(csm).toBeDefined();
      expect(csm?.site).toBe(Site.POSTSCRIPT);
      // D-09 case-symmetric lock.
      expect(csm?.companyName).toBe('Postscript');
      expect(csm?.companyName?.toLowerCase()).toBe('postscript');
      // D-10 trailing-pad lock — wire title carries trailing-
      // space pad; emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Senior Customer Success Manager ');
      expect(csm?.title).toBe('Senior Customer Success Manager');
      expect(csm?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(csm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/postscript/jobs/8531822002',
      );
      expect(csm?.jobUrl).toContain('job-boards.greenhouse.io/postscript/jobs/');
      // D-11 clean dept pass-through.
      expect(csm?.department).toBe('Customer Success');
      expect(csm?.location?.city).toBe('Remote, US');
      expect(csm?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(csm?.description).not.toContain('&lt;');
      expect(csm?.description).not.toContain('&amp;');
      expect(csm?.description).not.toContain('<p>');
      expect(csm?.description).not.toContain('<strong>');
      expect(csm?.description).toContain('Postscript');

      const sbe = dto.jobs.find((j) => j.id === 'postscript-8525612002');
      expect(sbe).toBeDefined();
      expect(sbe?.title).toBe('Senior Backend Engineer');
      expect(sbe?.companyName).toBe('Postscript');
      expect(sbe?.location?.city).toBe('Remote, US');
      expect(sbe?.isRemote).toBe(true);
      expect(sbe?.department).toBe('Engineering');
      expect(sbe?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/postscript/jobs/8525612002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/postscript/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
        searchTerm: 'BACKEND',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('postscript-8525612002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
        searchTerm: 'success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('postscript-8531822002');
      expect(result.jobs[0].department).toBe('Customer Success');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new PostscriptService();
      const result = await service.scrape({
        siteType: [Site.POSTSCRIPT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
