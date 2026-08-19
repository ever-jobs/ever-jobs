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

import { IterableModule, IterableService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'iterable-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 159 / T04 — `IterableService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `IterableService` through `IterableModule`.
 *   2. `Site.ITERABLE === 'iterable'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Iterable'` lock; **D-10 mixed-pad title trim
 *      lock** (leading + trailing pads — 8th cohort leading-pad
 *      observation); D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('IterableService — Spec 159 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through IterableModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IterableModule],
      }).compile();
      const service = moduleRef.get(IterableService);
      expect(service).toBeInstanceOf(IterableService);
      await moduleRef.close();
    });

    it('exports the Site.ITERABLE = "iterable" enum value', () => {
      expect(Site.ITERABLE).toBe('iterable');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const fpa = dto.jobs.find((j) => j.id === 'iterable-7872322');
      expect(fpa).toBeDefined();
      expect(fpa?.site).toBe(Site.ITERABLE);
      // D-09 case-symmetric lock.
      expect(fpa?.companyName).toBe('Iterable');
      expect(fpa?.companyName?.toLowerCase()).toBe('iterable');
      // **D-10 leading-pad sub-axis lock** — 8th cohort
      // observation. Wire title carries leading-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(' FP&A Manager');
      expect(fpa?.title).toBe('FP&A Manager');
      expect(fpa?.title).not.toMatch(/^\s/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(fpa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/iterable/jobs/7872322',
      );
      expect(fpa?.jobUrl).toContain('job-boards.greenhouse.io/iterable/jobs/');
      // D-11 clean dept pass-through.
      expect(fpa?.department).toBe('Finance');
      expect(fpa?.location?.city).toBe('San Francisco, CA');
      expect(fpa?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(fpa?.description).not.toContain('&lt;');
      expect(fpa?.description).not.toContain('&amp;');
      expect(fpa?.description).not.toContain('<p>');
      expect(fpa?.description).not.toContain('<strong>');
      expect(fpa?.description).toContain('Iterable');

      const sre = dto.jobs.find((j) => j.id === 'iterable-7507831');
      expect(sre).toBeDefined();
      // D-10 trailing-pad lock.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Site Reliability Engineer (Cloud Platform) ');
      expect(sre?.title).toBe('Senior Site Reliability Engineer (Cloud Platform)');
      expect(sre?.title).not.toMatch(/\s$/);
      expect(sre?.companyName).toBe('Iterable');
      expect(sre?.location?.city).toBe('Lisbon, Portugal');
      expect(sre?.isRemote).toBe(false);
      expect(sre?.department).toBe('Engineering');
      expect(sre?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/iterable/jobs/7507831',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/iterable/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
        searchTerm: 'RELIABILITY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('iterable-7507831');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
        searchTerm: 'finance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('iterable-7872322');
      expect(result.jobs[0].department).toBe('Finance');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new IterableService();
      const result = await service.scrape({
        siteType: [Site.ITERABLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
