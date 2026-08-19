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

import { XaiModule, XaiService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'xai-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 105 / T04 — `XaiService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `XaiService` through `XaiModule`.
 *   2. `Site.XAI === 'xai'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 mixed-case
 *      TWO-cap-at-1/2 short wire `'xAI'` (first cohort
 *      observation of lowercase-first + uppercase-last-two
 *      pattern); D-10 trailing-pad title trim; D-11 clean dept
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('XaiService — Spec 105 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through XaiModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [XaiModule],
      }).compile();
      const service = moduleRef.get(XaiService);
      expect(service).toBeInstanceOf(XaiService);
      await moduleRef.close();
    });

    it('exports the Site.XAI = "xai" enum value', () => {
      expect(Site.XAI).toBe('xai');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const t = dto.jobs.find((j) => j.id === 'xai-5045788007');
      expect(t).toBeDefined();
      expect(t?.site).toBe(Site.XAI);
      // **D-09 lock — FIRST-COHORT mixed-case TWO-cap-at-1/2
      // short wire form**: emitted `companyName === 'xAI'` byte-
      // for-byte (3 bytes; lowercase 'x' at index 0, uppercase
      // 'A' at index 1, uppercase 'I' at index 2).
      expect(t?.companyName).toBe('xAI');
      expect(t?.companyName?.length).toBe(3);
      expect(t?.companyName?.toLowerCase()).toBe('xai');
      expect(t?.companyName?.charCodeAt(0)).toBe(120); // 'x' (lowercase)
      expect(t?.companyName?.charCodeAt(1)).toBe(65);  // 'A'
      expect(t?.companyName?.charCodeAt(2)).toBe(73);  // 'I'
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('3D Tutor ');
      expect(t?.title).toBe('3D Tutor');
      expect(t?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(t?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(t?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/xai/jobs/5045788007',
      );
      expect(t?.jobUrl).toContain('job-boards.greenhouse.io/xai/jobs/');
      expect(t?.jobUrl).not.toContain('xai.com');
      expect(t?.department).toBe('Human Data');
      expect(t?.location?.city).toBe('Remote');
      expect(t?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(t?.description).not.toContain('&lt;');
      expect(t?.description).not.toContain('&amp;');
      expect(t?.description).not.toContain('<p>');
      expect(t?.description).not.toContain('<strong>');
      expect(t?.description).toContain('xAI');

      const dco = dto.jobs.find((j) => j.id === 'xai-4922800007');
      expect(dco).toBeDefined();
      expect(dco?.title).toBe('Senior Datacenter Operations Engineer');
      expect(dco?.companyName).toBe('xAI');
      expect(dco?.location?.city).toBe('Memphis, TN');
      expect(dco?.isRemote).toBe(false);
      expect(dco?.department).toBe('Data Center');
      expect(dco?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/xai/jobs/4922800007',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/xai/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
        searchTerm: 'DATACENTER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('xai-4922800007');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
        searchTerm: 'human data',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('xai-5045788007');
      expect(result.jobs[0].department).toBe('Human Data');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new XaiService();
      const result = await service.scrape({
        siteType: [Site.XAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
