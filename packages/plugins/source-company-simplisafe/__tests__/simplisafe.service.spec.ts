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

import { SimplisafeModule, SimplisafeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'simplisafe-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 171 / T04 — `SimplisafeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SimplisafeService` through `SimplisafeModule`.
 *   2. `Site.SIMPLISAFE === 'simplisafe'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      TWO-cap PascalCase case-asymmetric wire pin**
 *      (`'SimpliSafe'` 10 bytes; caps at 0/6 — 8th cohort
 *      observation, third caps-at-0/6 sub-pattern after
 *      LaunchDarkly Spec 102 and ComplyAdvantage Spec 141);
 *      D-10 trailing-pad title-trim lock; D-11 clean dept
 *      pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('SimplisafeService — Spec 171 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SimplisafeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SimplisafeModule],
      }).compile();
      const service = moduleRef.get(SimplisafeService);
      expect(service).toBeInstanceOf(SimplisafeService);
      await moduleRef.close();
    });

    it('exports the Site.SIMPLISAFE = "simplisafe" enum value', () => {
      expect(Site.SIMPLISAFE).toBe('simplisafe');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cam = dto.jobs.find((j) => j.id === 'simplisafe-7859472');
      expect(cam).toBeDefined();
      expect(cam?.site).toBe(Site.SIMPLISAFE);
      // D-09 TWO-cap PascalCase case-asymmetric lock.
      expect(cam?.companyName).toBe('SimpliSafe');
      expect(cam?.companyName?.toLowerCase()).toBe('simplisafe');
      // Verify caps positions: 0 (S), 6 (S).
      const cn = cam?.companyName ?? '';
      expect(cn[0]).toBe('S');
      expect(cn[6]).toBe('S');
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(
        'Customer Analytics Manager, Activations & Adoption ',
      );
      expect(cam?.title).toBe('Customer Analytics Manager, Activations & Adoption');
      expect(cam?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(cam?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/simplisafe/jobs/7859472',
      );
      expect(cam?.jobUrl).toContain('job-boards.greenhouse.io/simplisafe/jobs/');
      // D-11 clean dept pass-through.
      expect(cam?.department).toBe('Marketing');
      expect(cam?.location?.city).toBe('Richmond, VA');
      expect(cam?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(cam?.description).not.toContain('&lt;');
      expect(cam?.description).not.toContain('&amp;');
      expect(cam?.description).not.toContain('<p>');
      expect(cam?.description).toContain('SimpliSafe');

      const sae = dto.jobs.find((j) => j.id === 'simplisafe-7819412');
      expect(sae).toBeDefined();
      // D-10 lock — second listing also trailing-padded.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Automation Engineer (Firmware) ');
      expect(sae?.title).toBe('Senior Automation Engineer (Firmware)');
      expect(sae?.title).not.toMatch(/\s$/);
      expect(sae?.companyName).toBe('SimpliSafe');
      expect(sae?.location?.city).toBe('Remote, US');
      expect(sae?.isRemote).toBe(true);
      expect(sae?.department).toBe('Engineering');
      expect(sae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/simplisafe/jobs/7819412',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/simplisafe/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
        searchTerm: 'FIRMWARE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('simplisafe-7819412');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('simplisafe-7859472');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SimplisafeService();
      const result = await service.scrape({
        siteType: [Site.SIMPLISAFE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
