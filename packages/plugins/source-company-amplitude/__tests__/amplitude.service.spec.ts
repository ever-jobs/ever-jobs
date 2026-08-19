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

import { AmplitudeModule, AmplitudeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'amplitude-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 107 / T04 — `AmplitudeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AmplitudeService` through `AmplitudeModule`.
 *   2. `Site.AMPLITUDE === 'amplitude'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 APPLIED
 *      with TRAILING-space pad sub-axis (wire `'Amplitude '`
 *      10 bytes → trim → `'Amplitude'` 9 bytes); D-10 trailing-
 *      pad title trim; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AmplitudeService — Spec 107 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AmplitudeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AmplitudeModule],
      }).compile();
      const service = moduleRef.get(AmplitudeService);
      expect(service).toBeInstanceOf(AmplitudeService);
      await moduleRef.close();
    });

    it('exports the Site.AMPLITUDE = "amplitude" enum value', () => {
      expect(Site.AMPLITUDE).toBe('amplitude');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ai = dto.jobs.find((j) => j.id === 'amplitude-8519031002');
      expect(ai).toBeDefined();
      expect(ai?.site).toBe(Site.AMPLITUDE);
      // **D-09 lock — APPLIED with TRAILING-space pad sub-axis**:
      // wire `'Amplitude '` (10 bytes, trailing space) trimmed →
      // emitted `'Amplitude'` (9 bytes, no trailing whitespace).
      expect(JOBS_PAGE_RAW.jobs[0].company_name).toBe('Amplitude ');
      expect(JOBS_PAGE_RAW.jobs[0].company_name.length).toBe(10);
      expect(JOBS_PAGE_RAW.jobs[0].company_name.charCodeAt(9)).toBe(32); // ' '
      expect(ai?.companyName).toBe('Amplitude');
      expect(ai?.companyName?.length).toBe(9);
      expect(ai?.companyName).not.toMatch(/\s$/);
      expect(ai?.companyName).not.toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AI Tech Partner Lead ');
      expect(ai?.title).toBe('AI Tech Partner Lead');
      expect(ai?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ai?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/amplitude/jobs/8519031002',
      );
      expect(ai?.jobUrl).toContain('job-boards.greenhouse.io/amplitude/jobs/');
      expect(ai?.jobUrl).not.toContain('amplitude.com');
      expect(ai?.department).toBe('CFO : Financial Planning');
      expect(ai?.location?.city).toBe('Remote - USA');
      expect(ai?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ai?.description).not.toContain('&lt;');
      expect(ai?.description).not.toContain('&amp;');
      expect(ai?.description).not.toContain('<p>');
      expect(ai?.description).not.toContain('<strong>');
      expect(ai?.description).toContain('Amplitude');

      const sem = dto.jobs.find((j) => j.id === 'amplitude-8507755002');
      expect(sem).toBeDefined();
      expect(sem?.title).toBe('Senior Engineering Manager, Platform');
      expect(sem?.companyName).toBe('Amplitude');
      expect(sem?.location?.city).toBe('San Francisco, CA');
      expect(sem?.isRemote).toBe(false);
      expect(sem?.department).toBe('Engineering');
      expect(sem?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/amplitude/jobs/8507755002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/amplitude/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
        searchTerm: 'PARTNER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('amplitude-8519031002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('amplitude-8507755002');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AmplitudeService();
      const result = await service.scrape({
        siteType: [Site.AMPLITUDE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
