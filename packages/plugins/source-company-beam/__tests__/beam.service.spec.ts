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

import { BeamModule, BeamService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'beam-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 136 / T04 — `BeamService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BeamService` through `BeamModule`.
 *   2. `Site.BEAM === 'beam'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09 first-
 *      cohort slug-acronym-expansion asymmetric wire**
 *      lock — slug `beam` (4b) vs wire `'Bridge to Enter
 *      Advanced Mathematics (BEAM)'` (43b); D-10 byte-for-
 *      byte title pass-through (no trim) lock; D-11 clean
 *      dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BeamService — Spec 136 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BeamModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BeamModule],
      }).compile();
      const service = moduleRef.get(BeamService);
      expect(service).toBeInstanceOf(BeamService);
      await moduleRef.close();
    });

    it('exports the Site.BEAM = "beam" enum value', () => {
      expect(Site.BEAM).toBe('beam');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ad = dto.jobs.find((j) => j.id === 'beam-4644064005');
      expect(ad).toBeDefined();
      expect(ad?.site).toBe(Site.BEAM);
      // **D-09 first-cohort slug-acronym-expansion asymmetry
      // lock** — wire `'Bridge to Enter Advanced Mathematics
      // (BEAM)'` 43 bytes (full org name + acronym in
      // parens); slug `beam` 4 bytes (acronym only).
      expect(ad?.companyName).toBe('Bridge to Enter Advanced Mathematics (BEAM)');
      expect(ad?.companyName?.length).toBe(43);
      expect(ad?.companyName).toContain('(BEAM)');
      expect(ad?.companyName).toContain('Bridge to Enter Advanced Mathematics');
      expect(ad?.companyName?.toLowerCase()).toContain('beam');
      // D-10 lock — wire title is clean; emitted byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Academic Director, BEAM Summer Away');
      expect(ad?.title).toBe('Academic Director, BEAM Summer Away');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ad?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/beam/jobs/4644064005',
      );
      expect(ad?.jobUrl).toContain('job-boards.greenhouse.io/beam/jobs/');
      expect(ad?.department).toBe('Summer Programs');
      expect(ad?.location?.city).toBe('New York, NY');
      expect(ad?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ad?.description).not.toContain('&lt;');
      expect(ad?.description).not.toContain('&amp;');
      expect(ad?.description).not.toContain('<p>');
      expect(ad?.description).not.toContain('<strong>');
      expect(ad?.description).toContain('BEAM');

      const md = dto.jobs.find((j) => j.id === 'beam-4789215007');
      expect(md).toBeDefined();
      expect(md?.title).toBe('Manager, Donor Engagement & Partnerships (Hybrid - NYC)');
      expect(md?.companyName).toBe('Bridge to Enter Advanced Mathematics (BEAM)');
      expect(md?.location?.city).toBe('New York, NY');
      expect(md?.isRemote).toBe(false);
      expect(md?.department).toBe('HQ Fundraising');
      expect(md?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/beam/jobs/4789215007',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/beam/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
        searchTerm: 'DONOR',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('beam-4789215007');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
        searchTerm: 'summer',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('beam-4644064005');
      expect(result.jobs[0].department).toBe('Summer Programs');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BeamService();
      const result = await service.scrape({
        siteType: [Site.BEAM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
