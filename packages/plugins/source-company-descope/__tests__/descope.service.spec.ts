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

import { DescopeModule, DescopeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'descope-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 125 / T04 — `DescopeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DescopeService` through `DescopeModule`.
 *   2. `Site.DESCOPE === 'descope'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Descope'` lock; D-10 byte-for-byte title
 *      pass-through (no trim) lock; **D-11 APPLIED lock**
 *      with `'Customer Success '` and `'Engineering '` padded
 *      → both trim to clean.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DescopeService — Spec 125 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DescopeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DescopeModule],
      }).compile();
      const service = moduleRef.get(DescopeService);
      expect(service).toBeInstanceOf(DescopeService);
      await moduleRef.close();
    });

    it('exports the Site.DESCOPE = "descope" enum value', () => {
      expect(Site.DESCOPE).toBe('descope');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cse = dto.jobs.find((j) => j.id === 'descope-4236838009');
      expect(cse).toBeDefined();
      expect(cse?.site).toBe(Site.DESCOPE);
      // D-09 case-symmetric lock.
      expect(cse?.companyName).toBe('Descope');
      expect(cse?.companyName?.toLowerCase()).toBe('descope');
      // D-10 lock — wire title is clean; emitted byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Customer Success Engineer');
      expect(cse?.title).toBe('Customer Success Engineer');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(cse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/descope/jobs/4236838009',
      );
      expect(cse?.jobUrl).toContain('job-boards.greenhouse.io/descope/jobs/');
      // **D-11 APPLIED lock — wire dept carries trailing-
      // space pad; emitted dept trimmed.**
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Customer Success ');
      expect(cse?.department).toBe('Customer Success');
      expect(cse?.department).not.toMatch(/\s$/);
      expect(cse?.location?.city).toBe('Remote, US');
      expect(cse?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(cse?.description).not.toContain('&lt;');
      expect(cse?.description).not.toContain('&amp;');
      expect(cse?.description).not.toContain('<p>');
      expect(cse?.description).not.toContain('<strong>');
      expect(cse?.description).toContain('Descope');

      const sse = dto.jobs.find((j) => j.id === 'descope-4341509006');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, MCP');
      expect(sse?.companyName).toBe('Descope');
      expect(sse?.location?.city).toBe('Tel Aviv, Israel');
      expect(sse?.isRemote).toBe(false);
      // **D-11 APPLIED lock — second sample**: wire dept
      // `'Engineering '` padded; emitted trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Engineering ');
      expect(sse?.department).toBe('Engineering');
      expect(sse?.department).not.toMatch(/\s$/);
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/descope/jobs/4341509006',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/descope/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
        searchTerm: 'MCP',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('descope-4341509006');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('descope-4236838009');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('Customer Success');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DescopeService();
      const result = await service.scrape({
        siteType: [Site.DESCOPE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
