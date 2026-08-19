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

import { LaunchdarklyModule, LaunchdarklyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'launchdarkly-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 114 / T04 — `LaunchdarklyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `LaunchdarklyService` through `LaunchdarklyModule`.
 *   2. `Site.LAUNCHDARKLY === 'launchdarkly'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 PascalCase
 *      TWO-cap case-asymmetric `'LaunchDarkly'` lock (caps at
 *      0/6); D-10 trailing-pad title trim; D-11 clean dept
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('LaunchdarklyService — Spec 114 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through LaunchdarklyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [LaunchdarklyModule],
      }).compile();
      const service = moduleRef.get(LaunchdarklyService);
      expect(service).toBeInstanceOf(LaunchdarklyService);
      await moduleRef.close();
    });

    it('exports the Site.LAUNCHDARKLY = "launchdarkly" enum value', () => {
      expect(Site.LAUNCHDARKLY).toBe('launchdarkly');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eae = dto.jobs.find((j) => j.id === 'launchdarkly-7649833003');
      expect(eae).toBeDefined();
      expect(eae?.site).toBe(Site.LAUNCHDARKLY);
      // **D-09 PascalCase TWO-cap case-asymmetric lock — caps
      // at byte indices 0 and 6**: emitted `'LaunchDarkly'`
      // byte-for-byte (12 bytes); case-asymmetric vs the
      // lowercase 12-byte slug `launchdarkly` at TWO indices.
      expect(eae?.companyName).toBe('LaunchDarkly');
      expect(eae?.companyName?.length).toBe(12);
      expect(eae?.companyName?.[0]).toBe('L');
      expect(eae?.companyName?.[6]).toBe('D');
      expect(eae?.companyName?.toLowerCase()).toBe('launchdarkly');
      expect(eae?.companyName).not.toBe('launchdarkly');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Enterprise Account Executive - Germany ');
      expect(eae?.title).toBe('Enterprise Account Executive - Germany');
      expect(eae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(eae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/launchdarkly/jobs/7649833003',
      );
      expect(eae?.jobUrl).toContain('job-boards.greenhouse.io/launchdarkly/jobs/');
      expect(eae?.department).toBe('Sales');
      expect(eae?.location?.city).toBe('Remote, Germany');
      expect(eae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(eae?.description).not.toContain('&lt;');
      expect(eae?.description).not.toContain('&amp;');
      expect(eae?.description).not.toContain('<p>');
      expect(eae?.description).not.toContain('<strong>');
      expect(eae?.description).toContain('LaunchDarkly');

      const sse = dto.jobs.find((j) => j.id === 'launchdarkly-7717250003');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Core');
      expect(sse?.companyName).toBe('LaunchDarkly');
      expect(sse?.location?.city).toBe('Oakland, CA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Core Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/launchdarkly/jobs/7717250003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/launchdarkly/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
        searchTerm: 'GERMANY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('launchdarkly-7649833003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
        searchTerm: 'core engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('launchdarkly-7717250003');
      expect(result.jobs[0].department).toBe('Core Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new LaunchdarklyService();
      const result = await service.scrape({
        siteType: [Site.LAUNCHDARKLY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
