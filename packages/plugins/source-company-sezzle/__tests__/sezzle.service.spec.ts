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

import { SezzleModule, SezzleService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'sezzle-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 169 / T04 — `SezzleService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SezzleService` through `SezzleModule`.
 *   2. `Site.SEZZLE === 'sezzle'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Sezzle'` lock; D-10 mixed-pad title trim
 *      lock (trailing + leading); **D-11 NEW both-end pad
 *      sub-axis lock** with `'  EX-Executive '` (2-character
 *      leading + 1-character trailing whitespace) trimmed →
 *      `'EX-Executive'`; clean dept pass-through lock for
 *      `'DV-Development'`.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('SezzleService — Spec 169 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SezzleModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SezzleModule],
      }).compile();
      const service = moduleRef.get(SezzleService);
      expect(service).toBeInstanceOf(SezzleService);
      await moduleRef.close();
    });

    it('exports the Site.SEZZLE = "sezzle" enum value', () => {
      expect(Site.SEZZLE).toBe('sezzle');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cro = dto.jobs.find((j) => j.id === 'sezzle-7700447003');
      expect(cro).toBeDefined();
      expect(cro?.site).toBe(Site.SEZZLE);
      // D-09 case-symmetric lock.
      expect(cro?.companyName).toBe('Sezzle');
      expect(cro?.companyName?.toLowerCase()).toBe('sezzle');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Chief Risk Officer ');
      expect(cro?.title).toBe('Chief Risk Officer');
      expect(cro?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(cro?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/sezzle/jobs/7700447003',
      );
      expect(cro?.jobUrl).toContain('job-boards.greenhouse.io/sezzle/jobs/');
      // **D-11 NEW both-end pad sub-axis lock** — wire dept
      // `'  EX-Executive '` carries 2-character leading
      // whitespace + 1-character trailing whitespace
      // simultaneously (first cohort observation of D-11
      // both-end pad sub-axis AND first cohort observation of
      // multi-character (2-character) leading whitespace pad
      // on a wire department name); emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('  EX-Executive ');
      expect(cro?.department).toBe('EX-Executive');
      expect(cro?.department).not.toMatch(/^\s/);
      expect(cro?.department).not.toMatch(/\s$/);
      expect(cro?.location?.city).toBe('Minneapolis, United States');
      expect(cro?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(cro?.description).not.toContain('&lt;');
      expect(cro?.description).not.toContain('&amp;');
      expect(cro?.description).not.toContain('<p>');
      expect(cro?.description).not.toContain('<strong>');
      expect(cro?.description).toContain('Sezzle');

      const ai = dto.jobs.find((j) => j.id === 'sezzle-7633956003');
      expect(ai).toBeDefined();
      // **D-10 leading-pad sub-axis lock** — 10th cohort
      // observation. Wire title carries leading-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' AI Engineer I (Remote)');
      expect(ai?.title).toBe('AI Engineer I (Remote)');
      expect(ai?.title).not.toMatch(/^\s/);
      expect(ai?.companyName).toBe('Sezzle');
      expect(ai?.location?.city).toBe('Bogota, Colombia');
      // location string does not contain 'remote'; isRemote stays false.
      expect(ai?.isRemote).toBe(false);
      // **D-11 clean dept pass-through lock** — wire dept
      // `'DV-Development'` is fully clean; emitted dept
      // byte-for-byte identical (defensive `.trim()` is a
      // safe no-op).
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('DV-Development');
      expect(ai?.department).toBe('DV-Development');
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/sezzle/jobs/7633956003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/sezzle/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sezzle-7633956003');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
        searchTerm: 'executive',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('sezzle-7700447003');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('EX-Executive');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SezzleService();
      const result = await service.scrape({
        siteType: [Site.SEZZLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
