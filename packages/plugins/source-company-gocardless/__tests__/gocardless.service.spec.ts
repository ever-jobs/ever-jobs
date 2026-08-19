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

import { GocardlessModule, GocardlessService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'gocardless-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 150 / T04 — `GocardlessService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `GocardlessService` through `GocardlessModule`.
 *   2. `Site.GOCARDLESS === 'gocardless'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      TWO-cap PascalCase case-asymmetric wire pin**
 *      (`'GoCardless'` 10 bytes; caps at 0/2 — 7th cohort
 *      observation, third caps-at-0/2 sub-pattern); D-10
 *      trailing-pad title-trim lock; D-11 clean dept
 *      pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('GocardlessService — Spec 150 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through GocardlessModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GocardlessModule],
      }).compile();
      const service = moduleRef.get(GocardlessService);
      expect(service).toBeInstanceOf(GocardlessService);
      await moduleRef.close();
    });

    it('exports the Site.GOCARDLESS = "gocardless" enum value', () => {
      expect(Site.GOCARDLESS).toBe('gocardless');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const lod = dto.jobs.find((j) => j.id === 'gocardless-7672622');
      expect(lod).toBeDefined();
      expect(lod?.site).toBe(Site.GOCARDLESS);
      // D-09 TWO-cap PascalCase case-asymmetric lock.
      expect(lod?.companyName).toBe('GoCardless');
      expect(lod?.companyName?.toLowerCase()).toBe('gocardless');
      // Verify caps positions: 0 (G), 2 (C).
      const cn = lod?.companyName ?? '';
      expect(cn[0]).toBe('G');
      expect(cn[2]).toBe('C');
      expect(lod?.title).toBe('2LoD Assurance Manager');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(lod?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/gocardless/jobs/7672622',
      );
      expect(lod?.jobUrl).toContain('job-boards.greenhouse.io/gocardless/jobs/');
      // D-11 clean dept pass-through.
      expect(lod?.department).toBe('Risk');
      expect(lod?.location?.city).toBe('London, UK');
      expect(lod?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(lod?.description).not.toContain('&lt;');
      expect(lod?.description).not.toContain('&amp;');
      expect(lod?.description).not.toContain('<p>');
      expect(lod?.description).toContain('GoCardless');

      const sre = dto.jobs.find((j) => j.id === 'gocardless-7858028');
      expect(sre).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Site Reliability Engineer ');
      expect(sre?.title).toBe('Site Reliability Engineer');
      expect(sre?.title).not.toMatch(/\s$/);
      expect(sre?.companyName).toBe('GoCardless');
      expect(sre?.location?.city).toBe('Remote, UK');
      expect(sre?.isRemote).toBe(true);
      expect(sre?.department).toBe('Product Development');
      expect(sre?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/gocardless/jobs/7858028',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/gocardless/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
        searchTerm: 'RELIABILITY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gocardless-7858028');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
        searchTerm: 'risk',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gocardless-7672622');
      expect(result.jobs[0].department).toBe('Risk');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new GocardlessService();
      const result = await service.scrape({
        siteType: [Site.GOCARDLESS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
