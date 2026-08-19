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

import { FoundersModule, FoundersService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'founders-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 148 / T04 — `FoundersService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FoundersService` through `FoundersModule`.
 *   2. `Site.FOUNDERS === 'founders'` literal pin.
 *   3. Happy path — variant-10 URL pass-through; **D-09
 *      THIRD-COHORT slug-truncation asymmetric wire pin**
 *      (`'Founders Green Animal Hospital'` 30 bytes vs slug
 *      `founders` 8 bytes — truncates to first token only);
 *      D-10 omitted byte-for-byte title pass-through (no
 *      trim) lock; D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('FoundersService — Spec 148 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FoundersModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FoundersModule],
      }).compile();
      const service = moduleRef.get(FoundersService);
      expect(service).toBeInstanceOf(FoundersService);
      await moduleRef.close();
    });

    it('exports the Site.FOUNDERS = "founders" enum value', () => {
      expect(Site.FOUNDERS).toBe('founders');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const tech = dto.jobs.find((j) => j.id === 'founders-8478469002');
      expect(tech).toBeDefined();
      expect(tech?.site).toBe(Site.FOUNDERS);
      // D-09 slug-truncation asymmetric lock — wire is full
      // 4-token legal entity name; slug is first token only.
      expect(tech?.companyName).toBe('Founders Green Animal Hospital');
      expect(tech?.companyName?.split(' ')).toHaveLength(4);
      expect(tech?.companyName?.split(' ')[0].toLowerCase()).toBe('founders');
      expect(tech?.title).toBe('Registered Veterinary Technician');
      // D-04 lock — variant 10 (legacy hosted-board apex).
      expect(tech?.jobUrl).toBe(
        'https://boards.greenhouse.io/founders/jobs/8478469002?gh_jid=8478469002',
      );
      expect(tech?.jobUrl).toContain('boards.greenhouse.io/founders/jobs/');
      // D-11 clean dept pass-through.
      expect(tech?.department).toBe('Technicians');
      expect(tech?.location?.city).toBe('Pasadena, CA');
      expect(tech?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(tech?.description).not.toContain('&lt;');
      expect(tech?.description).not.toContain('<p>');
      expect(tech?.description).toContain('Founders Green Animal Hospital');

      const rec = dto.jobs.find((j) => j.id === 'founders-8519059002');
      expect(rec).toBeDefined();
      expect(rec?.title).toBe('Veterinary Receptionist');
      expect(rec?.companyName).toBe('Founders Green Animal Hospital');
      expect(rec?.location?.city).toBe('Pasadena, CA');
      expect(rec?.isRemote).toBe(false);
      expect(rec?.department).toBe('Reception');
      expect(rec?.jobUrl).toBe(
        'https://boards.greenhouse.io/founders/jobs/8519059002?gh_jid=8519059002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/founders/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
        searchTerm: 'TECHNICIAN',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('founders-8478469002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
        searchTerm: 'reception',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('founders-8519059002');
      expect(result.jobs[0].department).toBe('Reception');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FoundersService();
      const result = await service.scrape({
        siteType: [Site.FOUNDERS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
