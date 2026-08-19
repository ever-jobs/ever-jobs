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

import { DeepmindModule, DeepmindService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'deepmind-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 156 / T04 — `DeepmindService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DeepmindService` through `DeepmindModule`.
 *   2. `Site.DEEPMIND === 'deepmind'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      TWO-cap PascalCase case-asymmetric wire pin**
 *      (`'DeepMind'` 8 bytes; caps at 0/4 — NEW caps-at-0/4
 *      sub-pattern); D-10 trailing-pad title-trim lock; **D-11
 *      trailing-pad dept-trim lock** (`'Frontier AI '` →
 *      `'Frontier AI'`).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DeepmindService — Spec 156 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DeepmindModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DeepmindModule],
      }).compile();
      const service = moduleRef.get(DeepmindService);
      expect(service).toBeInstanceOf(DeepmindService);
      await moduleRef.close();
    });

    it('exports the Site.DEEPMIND = "deepmind" enum value', () => {
      expect(Site.DEEPMIND).toBe('deepmind');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ab = dto.jobs.find((j) => j.id === 'deepmind-7602072');
      expect(ab).toBeDefined();
      expect(ab?.site).toBe(Site.DEEPMIND);
      // D-09 TWO-cap PascalCase case-asymmetric lock — caps
      // at byte indices 0 (D) and 4 (M) — NEW caps-at-0/4
      // sub-pattern.
      expect(ab?.companyName).toBe('DeepMind');
      expect(ab?.companyName?.toLowerCase()).toBe('deepmind');
      const cn = ab?.companyName ?? '';
      expect(cn[0]).toBe('D');
      expect(cn[4]).toBe('M');
      // The segment split: Deep | Mind.
      expect(cn.slice(0, 4)).toBe('Deep');
      expect(cn.slice(4)).toBe('Mind');
      expect(ab?.title).toBe(
        'Administrative Business Partner (12 month fixed term contract)',
      );
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ab?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/deepmind/jobs/7602072',
      );
      // D-11 clean dept (this listing has clean wire dept).
      expect(ab?.department).toBe('Office of the CEO');
      expect(ab?.location?.city).toBe('London, UK');
      expect(ab?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ab?.description).not.toContain('&lt;');
      expect(ab?.description).not.toContain('<p>');
      expect(ab?.description).toContain('DeepMind');

      const re = dto.jobs.find((j) => j.id === 'deepmind-7822249');
      expect(re).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Research Engineer, Applied AI ');
      expect(re?.title).toBe('Research Engineer, Applied AI');
      expect(re?.title).not.toMatch(/\s$/);
      // D-11 lock — wire dept carries trailing-pad
      // (`'Frontier AI '`); emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Frontier AI ');
      expect(re?.department).toBe('Frontier AI');
      expect(re?.department).not.toMatch(/\s$/);
      expect(re?.companyName).toBe('DeepMind');
      expect(re?.location?.city).toBe('Mountain View, CA');
      expect(re?.isRemote).toBe(false);
      expect(re?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/deepmind/jobs/7822249',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/deepmind/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
        searchTerm: 'RESEARCH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('deepmind-7822249');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
        searchTerm: 'frontier',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('deepmind-7822249');
      expect(result.jobs[0].department).toBe('Frontier AI');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DeepmindService();
      const result = await service.scrape({
        siteType: [Site.DEEPMIND],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
