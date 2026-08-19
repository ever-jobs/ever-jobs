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

import { ContentfulModule, ContentfulService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'contentful-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 124 / T04 — `ContentfulService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ContentfulService` through `ContentfulModule`.
 *   2. `Site.CONTENTFUL === 'contentful'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Contentful'` lock; D-10 trailing-pad title
 *      trim lock; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ContentfulService — Spec 124 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ContentfulModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ContentfulModule],
      }).compile();
      const service = moduleRef.get(ContentfulService);
      expect(service).toBeInstanceOf(ContentfulService);
      await moduleRef.close();
    });

    it('exports the Site.CONTENTFUL = "contentful" enum value', () => {
      expect(Site.CONTENTFUL).toBe('contentful');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sec = dto.jobs.find((j) => j.id === 'contentful-7544101');
      expect(sec).toBeDefined();
      expect(sec?.site).toBe(Site.CONTENTFUL);
      // D-09 case-symmetric lock.
      expect(sec?.companyName).toBe('Contentful');
      expect(sec?.companyName?.toLowerCase()).toBe('contentful');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Manager, Security Engineering ');
      expect(sec?.title).toBe('Manager, Security Engineering');
      expect(sec?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(sec?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/contentful/jobs/7544101',
      );
      expect(sec?.jobUrl).toContain('job-boards.greenhouse.io/contentful/jobs/');
      expect(sec?.department).toBe('Security');
      expect(sec?.location?.city).toBe('Berlin, Germany');
      expect(sec?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(sec?.description).not.toContain('&lt;');
      expect(sec?.description).not.toContain('&amp;');
      expect(sec?.description).not.toContain('<p>');
      expect(sec?.description).not.toContain('<strong>');
      expect(sec?.description).toContain('Contentful');

      const sse = dto.jobs.find((j) => j.id === 'contentful-7681422');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Studio');
      expect(sse?.companyName).toBe('Contentful');
      expect(sse?.location?.city).toBe('Denver, CO');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/contentful/jobs/7681422',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/contentful/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
        searchTerm: 'STUDIO',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('contentful-7681422');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
        searchTerm: 'security',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('contentful-7544101');
      expect(result.jobs[0].department).toBe('Security');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ContentfulService();
      const result = await service.scrape({
        siteType: [Site.CONTENTFUL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
