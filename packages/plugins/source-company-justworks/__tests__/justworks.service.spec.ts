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

import { JustworksModule, JustworksService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'justworks-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 129 / T04 — `JustworksService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `JustworksService` through `JustworksModule`.
 *   2. `Site.JUSTWORKS === 'justworks'` literal pin.
 *   3. Happy path — variant-10 URL pass-through (legacy hosted-
 *      board apex); D-09 case-symmetric `'Justworks'` lock;
 *      **D-10 first-cohort double-trailing-space pad lock**
 *      (`'... (Remote)  '` — 2 spaces — trims to clean) +
 *      single-trailing-space pad lock (`'Senior Engineer,
 *      Knowledge Systems '`); D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('JustworksService — Spec 129 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through JustworksModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [JustworksModule],
      }).compile();
      const service = moduleRef.get(JustworksService);
      expect(service).toBeInstanceOf(JustworksService);
      await moduleRef.close();
    });

    it('exports the Site.JUSTWORKS = "justworks" enum value', () => {
      expect(Site.JUSTWORKS).toBe('justworks');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ocsa = dto.jobs.find((j) => j.id === 'justworks-7814842');
      expect(ocsa).toBeDefined();
      expect(ocsa?.site).toBe(Site.JUSTWORKS);
      // D-09 case-symmetric lock.
      expect(ocsa?.companyName).toBe('Justworks');
      expect(ocsa?.companyName?.toLowerCase()).toBe('justworks');
      // **D-10 lock — FIRST-COHORT double-trailing-space sub-
      // axis**: wire title carries 2 trailing spaces; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Overnight Customer Support Advocate (Remote)  ');
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/  $/);
      expect(ocsa?.title).toBe('Overnight Customer Support Advocate (Remote)');
      expect(ocsa?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 10 (legacy hosted-board apex).
      expect(ocsa?.jobUrl).toBe(
        'https://boards.greenhouse.io/justworks/jobs/7814842?gh_jid=7814842',
      );
      expect(ocsa?.jobUrl).toContain('boards.greenhouse.io/justworks/jobs/');
      expect(ocsa?.jobUrl).toContain('?gh_jid=7814842');
      expect(ocsa?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ocsa?.department).toBe('Customer Success');
      expect(ocsa?.location?.city).toBe('Remote, US');
      expect(ocsa?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ocsa?.description).not.toContain('&lt;');
      expect(ocsa?.description).not.toContain('&amp;');
      expect(ocsa?.description).not.toContain('<p>');
      expect(ocsa?.description).not.toContain('<strong>');
      expect(ocsa?.description).toContain('Justworks');

      const sek = dto.jobs.find((j) => j.id === 'justworks-7926531');
      expect(sek).toBeDefined();
      // D-10 lock — single-trailing-space sub-axis: trims clean.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Engineer, Knowledge Systems ');
      expect(sek?.title).toBe('Senior Engineer, Knowledge Systems');
      expect(sek?.title).not.toMatch(/\s$/);
      expect(sek?.companyName).toBe('Justworks');
      expect(sek?.location?.city).toBe('New York, NY');
      expect(sek?.isRemote).toBe(false);
      expect(sek?.department).toBe('Engineering');
      expect(sek?.jobUrl).toBe(
        'https://boards.greenhouse.io/justworks/jobs/7926531?gh_jid=7926531',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/justworks/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title (incl. double-space sub-axis)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
        searchTerm: 'OVERNIGHT',
      } as ScraperInputDto);

      // The double-trailing-space wire title `'... (Remote)  '`
      // matches `'OVERNIGHT'` after trim — proves the trim
      // happens BEFORE filter and handles 2-space pads.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('justworks-7814842');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('justworks-7926531');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new JustworksService();
      const result = await service.scrape({
        siteType: [Site.JUSTWORKS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
