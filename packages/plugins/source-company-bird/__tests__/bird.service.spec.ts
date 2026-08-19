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

import { BirdModule, BirdService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bird-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 153 / T04 — `BirdService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BirdService` through `BirdModule`.
 *   2. `Site.BIRD === 'bird'` literal pin.
 *   3. Happy path — **variant-41 URL byte-for-byte lock**
 *      (`www.bird.co/careers?gh_jid=<id>` `.co`-TLD careers-
 *      list-page query-only-id form); D-09 case-symmetric
 *      `'Bird'` lock; D-10 trailing-pad title-trim lock;
 *      D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BirdService — Spec 153 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BirdModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BirdModule],
      }).compile();
      const service = moduleRef.get(BirdService);
      expect(service).toBeInstanceOf(BirdService);
      await moduleRef.close();
    });

    it('exports the Site.BIRD = "bird" enum value', () => {
      expect(Site.BIRD).toBe('bird');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const co = dto.jobs.find((j) => j.id === 'bird-7704576003');
      expect(co).toBeDefined();
      expect(co?.site).toBe(Site.BIRD);
      // D-09 case-symmetric lock.
      expect(co?.companyName).toBe('Bird');
      expect(co?.companyName?.toLowerCase()).toBe('bird');
      expect(co?.title).toBe('City Operations Manager - (Michigan)');
      // D-04 lock — variant 41 (`.co` TLD careers-list-page
      // query-only-id form).
      expect(co?.jobUrl).toBe(
        'https://www.bird.co/careers?gh_jid=7704576003',
      );
      expect(co?.jobUrl).toContain('www.bird.co/careers');
      expect(co?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(co?.department).toBe('Operations');
      expect(co?.location?.city).toBe('Detroit, MI');
      expect(co?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(co?.description).not.toContain('&lt;');
      expect(co?.description).not.toContain('<p>');
      expect(co?.description).toContain('Bird');

      const vm = dto.jobs.find((j) => j.id === 'bird-7689437003');
      expect(vm).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Vehicle Mechanic - Bronx, NY ');
      expect(vm?.title).toBe('Vehicle Mechanic - Bronx, NY');
      expect(vm?.title).not.toMatch(/\s$/);
      expect(vm?.companyName).toBe('Bird');
      expect(vm?.location?.city).toBe('Bronx, NY');
      expect(vm?.isRemote).toBe(false);
      expect(vm?.department).toBe('Contractor');
      expect(vm?.jobUrl).toBe(
        'https://www.bird.co/careers?gh_jid=7689437003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bird/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
        searchTerm: 'MECHANIC',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bird-7689437003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
        searchTerm: 'operations',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bird-7704576003');
      expect(result.jobs[0].department).toBe('Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BirdService();
      const result = await service.scrape({
        siteType: [Site.BIRD],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
