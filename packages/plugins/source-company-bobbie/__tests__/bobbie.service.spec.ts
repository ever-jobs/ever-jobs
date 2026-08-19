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

import { BobbieModule, BobbieService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bobbie-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 093 / T04 — `BobbieService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BobbieService` through `BobbieModule`.
 *   2. `Site.BOBBIE === 'bobbie'` literal pin.
 *   3. Happy path — variant-2 URL pass-through (canonical
 *      Greenhouse `job-boards.greenhouse.io/bobbie/jobs/<id>`);
 *      D-09/D-10/D-11 all omitted (clean re-spin).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BobbieService — Spec 093 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BobbieModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BobbieModule],
      }).compile();
      const service = moduleRef.get(BobbieService);
      expect(service).toBeInstanceOf(BobbieService);
      await moduleRef.close();
    });

    it('exports the Site.BOBBIE = "bobbie" enum value', () => {
      expect(Site.BOBBIE).toBe('bobbie');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const med = dto.jobs.find((j) => j.id === 'bobbie-5359541004');
      expect(med).toBeDefined();
      expect(med?.site).toBe(Site.BOBBIE);
      expect(med?.companyName).toBe('Bobbie');
      expect(med?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-09 case-symmetric lock: lowercase form === slug.
      expect(med?.companyName?.toLowerCase()).toBe('bobbie');
      expect(med?.title).toBe('Bobbie Medical Representative (Contract)');
      expect(med?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // **D-04 lock — variant 2 (canonical Greenhouse host)**:
      // emitted `jobUrl` matches wire byte-for-byte; contains
      // `job-boards.greenhouse.io/bobbie/jobs/`; does NOT
      // contain `bobbie.com` (locks variant-2 against any
      // brand-domain variant).
      expect(med?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bobbie/jobs/5359541004',
      );
      expect(med?.jobUrl).toContain('job-boards.greenhouse.io/bobbie/jobs/');
      expect(med?.jobUrl).not.toContain('bobbie.com');
      expect(med?.department).toBe('Commercial');
      expect(med?.location?.city).toBe('Remote ');
      expect(med?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(med?.description).not.toContain('&lt;');
      expect(med?.description).not.toContain('&amp;');
      expect(med?.description).not.toContain('<p>');
      expect(med?.description).not.toContain('<strong>');
      expect(med?.description).toContain('Bobbie');
      expect(med?.description).toContain('&'); // entity-decoded ampersand round-trips

      const cgo = dto.jobs.find((j) => j.id === 'bobbie-5820765004');
      expect(cgo).toBeDefined();
      expect(cgo?.title).toBe('Chief Growth Officer');
      expect(cgo?.companyName).toBe('Bobbie');
      expect(cgo?.location?.city).toBe('San Francisco, CA');
      expect(cgo?.isRemote).toBe(false);
      expect(cgo?.department).toBe('Brand & Marketing');
      expect(cgo?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bobbie/jobs/5820765004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bobbie/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
        searchTerm: 'GROWTH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bobbie-5820765004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
        searchTerm: 'commercial',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bobbie-5359541004');
      expect(result.jobs[0].department).toBe('Commercial');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BobbieService();
      const result = await service.scrape({
        siteType: [Site.BOBBIE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
