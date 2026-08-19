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

import { ComplyAdvantageModule, ComplyAdvantageService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'complyadvantage-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 141 / T04 — `ComplyAdvantageService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ComplyAdvantageService` through `ComplyAdvantageModule`.
 *   2. `Site.COMPLYADVANTAGE === 'complyadvantage'` literal pin.
 *   3. Happy path — variant-13 URL pass-through; **D-09 TWO-cap
 *      PascalCase `'ComplyAdvantage'` lock (caps 0/6 — sister
 *      to LaunchDarkly)**; D-10 trailing-pad title-trim lock;
 *      D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ComplyAdvantageService — Spec 141 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ComplyAdvantageModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ComplyAdvantageModule],
      }).compile();
      const service = moduleRef.get(ComplyAdvantageService);
      expect(service).toBeInstanceOf(ComplyAdvantageService);
      await moduleRef.close();
    });

    it('exports the Site.COMPLYADVANTAGE = "complyadvantage" enum value', () => {
      expect(Site.COMPLYADVANTAGE).toBe('complyadvantage');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ds = dto.jobs.find((j) => j.id === 'complyadvantage-8524994002');
      expect(ds).toBeDefined();
      expect(ds?.site).toBe(Site.COMPLYADVANTAGE);
      // D-09 TWO-cap PascalCase case-asymmetric lock — caps at
      // byte indices 0 (`C`) and 6 (`A`); identical caps-position
      // pattern to LaunchDarkly (Spec 102).
      expect(ds?.companyName).toBe('ComplyAdvantage');
      expect(ds?.companyName).not.toBe('complyadvantage');
      expect(ds?.companyName?.charAt(0)).toBe('C');
      expect(ds?.companyName?.charAt(6)).toBe('A');
      expect(ds?.companyName?.toLowerCase()).toBe('complyadvantage');
      // D-10 trailing-pad lock — wire title carries trailing
      // single-ASCII-space; `.trim()` strips it.
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/ $/);
      expect(ds?.title).toBe('Data Scientist');
      expect(ds?.title).not.toMatch(/ $/);
      // D-04 lock — variant 13 (bare brand-domain dual-id form).
      expect(ds?.jobUrl).toBe(
        'https://complyadvantage.com/careers/jobs/8524994002?gh_jid=8524994002',
      );
      expect(ds?.jobUrl).toContain('complyadvantage.com/careers/jobs/');
      expect(ds?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(ds?.department).toBe('Technology');
      expect(ds?.location?.city).toBe('London, United Kingdom');
      expect(ds?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ds?.description).not.toContain('&lt;');
      expect(ds?.description).not.toContain('&amp;');
      expect(ds?.description).not.toContain('<p>');
      expect(ds?.description).toContain('ComplyAdvantage');

      const sd = dto.jobs.find((j) => j.id === 'complyadvantage-8524992002');
      expect(sd).toBeDefined();
      // D-10 trailing-pad lock (longer title sample).
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/ $/);
      expect(sd?.title).toBe('Senior Director, Revenue Operations');
      expect(sd?.title).not.toMatch(/ $/);
      expect(sd?.companyName).toBe('ComplyAdvantage');
      expect(sd?.location?.city).toBe('Remote, US');
      expect(sd?.isRemote).toBe(true);
      // D-11 clean dept pass-through (single-token form).
      expect(sd?.department).toBe('Commercial');
      expect(sd?.jobUrl).toBe(
        'https://complyadvantage.com/careers/jobs/8524992002?gh_jid=8524992002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/complyadvantage/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
        searchTerm: 'data',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('complyadvantage-8524994002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
        searchTerm: 'COMMERCIAL',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('complyadvantage-8524992002');
      expect(result.jobs[0].department).toBe('Commercial');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ComplyAdvantageService();
      const result = await service.scrape({
        siteType: [Site.COMPLYADVANTAGE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
