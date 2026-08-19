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

import { ConvivaModule, ConvivaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'conviva-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 142 / T04 — `ConvivaService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ConvivaService` through `ConvivaModule`.
 *   2. `Site.CONVIVA === 'conviva'` literal pin.
 *   3. Happy path — **variant-37 URL byte-for-byte lock**
 *      (`www.conviva.com/careers/job/<id>?gh_jid=<id>`); D-09
 *      case-symmetric `'Conviva'` lock; D-10 omitted byte-for-
 *      byte title pass-through (no trim) lock; D-11 clean dept
 *      pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ConvivaService — Spec 142 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ConvivaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ConvivaModule],
      }).compile();
      const service = moduleRef.get(ConvivaService);
      expect(service).toBeInstanceOf(ConvivaService);
      await moduleRef.close();
    });

    it('exports the Site.CONVIVA = "conviva" enum value', () => {
      expect(Site.CONVIVA).toBe('conviva');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const acc = dto.jobs.find((j) => j.id === 'conviva-7636543003');
      expect(acc).toBeDefined();
      expect(acc?.site).toBe(Site.CONVIVA);
      // D-09 case-symmetric lock.
      expect(acc?.companyName).toBe('Conviva');
      expect(acc?.companyName?.toLowerCase()).toBe('conviva');
      // D-10 omitted — title byte-for-byte pass-through (no trim).
      expect(acc?.title).toBe('Accountant, Payroll and Stock');
      // D-04 lock — variant 37 (www-prefixed singular-leaf
      // path-id dual-id).
      expect(acc?.jobUrl).toBe(
        'https://www.conviva.com/careers/job/7636543003?gh_jid=7636543003',
      );
      expect(acc?.jobUrl).toContain('www.conviva.com/careers/job/');
      expect(acc?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(acc?.department).toBe('Finance');
      expect(acc?.location?.city).toBe('Foster City, CA');
      expect(acc?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(acc?.description).not.toContain('&lt;');
      expect(acc?.description).not.toContain('&amp;');
      expect(acc?.description).not.toContain('<p>');
      expect(acc?.description).toContain('Conviva');

      const eng = dto.jobs.find((j) => j.id === 'conviva-7637558003');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, Streaming Analytics');
      expect(eng?.companyName).toBe('Conviva');
      expect(eng?.location?.city).toBe('Remote, US');
      expect(eng?.isRemote).toBe(true);
      expect(eng?.department).toBe('Technical Solutions');
      expect(eng?.jobUrl).toBe(
        'https://www.conviva.com/careers/job/7637558003?gh_jid=7637558003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/conviva/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('conviva-7637558003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
        searchTerm: 'finance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('conviva-7636543003');
      expect(result.jobs[0].department).toBe('Finance');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ConvivaService();
      const result = await service.scrape({
        siteType: [Site.CONVIVA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
