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

import { InstabaseModule, InstabaseService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'instabase-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 158 / T04 — `InstabaseService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `InstabaseService` through `InstabaseModule`.
 *   2. `Site.INSTABASE === 'instabase'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Instabase'` lock; D-10 mixed-pad title trim
 *      lock (trailing + leading pads); **D-11 APPLIED lock**
 *      with `'Finance/Accounting '` / `'Recruiting '` padded
 *      → trimmed.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('InstabaseService — Spec 158 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through InstabaseModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [InstabaseModule],
      }).compile();
      const service = moduleRef.get(InstabaseService);
      expect(service).toBeInstanceOf(InstabaseService);
      await moduleRef.close();
    });

    it('exports the Site.INSTABASE = "instabase" enum value', () => {
      expect(Site.INSTABASE).toBe('instabase');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const acct = dto.jobs.find((j) => j.id === 'instabase-7821445001');
      expect(acct).toBeDefined();
      expect(acct?.site).toBe(Site.INSTABASE);
      // D-09 case-symmetric lock.
      expect(acct?.companyName).toBe('Instabase');
      expect(acct?.companyName?.toLowerCase()).toBe('instabase');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Senior Accountant ');
      expect(acct?.title).toBe('Senior Accountant');
      expect(acct?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(acct?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/instabase/jobs/7821445001',
      );
      expect(acct?.jobUrl).toContain('job-boards.greenhouse.io/instabase/jobs/');
      // **D-11 APPLIED lock** — wire dept `'Finance/Accounting '`
      // padded; emitted dept trimmed (note: `/` separator
      // preserved byte-for-byte).
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Finance/Accounting ');
      expect(acct?.department).toBe('Finance/Accounting');
      expect(acct?.department).not.toMatch(/\s$/);
      expect(acct?.location?.city).toBe('San Francisco, CA');
      expect(acct?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(acct?.description).not.toContain('&lt;');
      expect(acct?.description).not.toContain('&amp;');
      expect(acct?.description).not.toContain('<p>');
      expect(acct?.description).not.toContain('<strong>');
      expect(acct?.description).toContain('Instabase');

      const rec = dto.jobs.find((j) => j.id === 'instabase-7903112002');
      expect(rec).toBeDefined();
      // **D-10 leading-pad sub-axis lock** — 7th cohort
      // observation. Wire title carries leading-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' Senior Technical Recruiter');
      expect(rec?.title).toBe('Senior Technical Recruiter');
      expect(rec?.title).not.toMatch(/^\s/);
      expect(rec?.companyName).toBe('Instabase');
      expect(rec?.location?.city).toBe('Bengaluru, India');
      expect(rec?.isRemote).toBe(false);
      // **D-11 APPLIED lock** — wire dept `'Recruiting '`
      // padded; emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Recruiting ');
      expect(rec?.department).toBe('Recruiting');
      expect(rec?.department).not.toMatch(/\s$/);
      expect(rec?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/instabase/jobs/7903112002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/instabase/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
        searchTerm: 'RECRUITER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('instabase-7903112002');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
        searchTerm: 'accounting',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('instabase-7821445001');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('Finance/Accounting');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new InstabaseService();
      const result = await service.scrape({
        siteType: [Site.INSTABASE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
