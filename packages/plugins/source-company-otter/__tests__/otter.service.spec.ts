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

import { OtterModule, OtterService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'otter-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 116 / T04 — `OtterService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `OtterService` through `OtterModule`.
 *   2. `Site.OTTER === 'otter'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Otter'` lock; D-10 trailing-pad title trim;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('OtterService — Spec 116 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through OtterModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [OtterModule],
      }).compile();
      const service = moduleRef.get(OtterService);
      expect(service).toBeInstanceOf(OtterService);
      await moduleRef.close();
    });

    it('exports the Site.OTTER = "otter" enum value', () => {
      expect(Site.OTTER).toBe('otter');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bse = dto.jobs.find((j) => j.id === 'otter-8430917002');
      expect(bse).toBeDefined();
      expect(bse?.site).toBe(Site.OTTER);
      // D-09 case-symmetric lock.
      expect(bse?.companyName).toBe('Otter');
      expect(bse?.companyName?.toLowerCase()).toBe('otter');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Backend Software Engineer, Otter - Los Angeles ');
      expect(bse?.title).toBe('Backend Software Engineer, Otter - Los Angeles');
      expect(bse?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(bse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/otter/jobs/8430917002',
      );
      expect(bse?.jobUrl).toContain('job-boards.greenhouse.io/otter/jobs/');
      expect(bse?.department).toBe('ENG Brick & Mortar');
      expect(bse?.location?.city).toBe('Los Angeles, CA');
      expect(bse?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(bse?.description).not.toContain('&lt;');
      expect(bse?.description).not.toContain('&amp;');
      expect(bse?.description).not.toContain('<p>');
      expect(bse?.description).not.toContain('<strong>');
      expect(bse?.description).toContain('Otter');

      const she = dto.jobs.find((j) => j.id === 'otter-8517208003');
      expect(she).toBeDefined();
      expect(she?.title).toBe('Senior Hardware Engineer');
      expect(she?.companyName).toBe('Otter');
      expect(she?.location?.city).toBe('Mountain View, CA');
      expect(she?.isRemote).toBe(false);
      expect(she?.department).toBe('Hardware Engineering');
      expect(she?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/otter/jobs/8517208003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/otter/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
        searchTerm: 'BACKEND',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('otter-8430917002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
        searchTerm: 'hardware',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('otter-8517208003');
      expect(result.jobs[0].department).toBe('Hardware Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new OtterService();
      const result = await service.scrape({
        siteType: [Site.OTTER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
