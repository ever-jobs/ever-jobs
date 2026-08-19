import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture
// rather than the live Greenhouse public API.
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

import { AffirmModule, AffirmService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'affirm-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 044 / T04 — `AffirmService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AffirmService` through `AffirmModule`.
 *   2. `Site.AFFIRM === 'affirm'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `affirm` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('AffirmService — Spec 044 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AffirmModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AffirmModule],
      }).compile();
      const service = moduleRef.get(AffirmService);
      expect(service).toBeInstanceOf(AffirmService);
      await moduleRef.close();
    });

    it('exports the Site.AFFIRM = "affirm" enum value', () => {
      expect(Site.AFFIRM).toBe('affirm');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AffirmService();
      const input: ScraperInputDto = {
        siteType: [Site.AFFIRM],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const credit = dto.jobs.find((j) => j.id === 'affirm-7666190003');
      expect(credit).toBeDefined();
      expect(credit?.site).toBe(Site.AFFIRM);
      expect(credit?.companyName).toBe('Affirm');
      expect(credit?.title).toBe('Analyst II, Credit Risk Analytics');
      // Wire shape: Greenhouse stores the new permalink subdomain
      // `job-boards.greenhouse.io` for this tenant (Spec 044 § 10 D-04).
      expect(credit?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/affirm/jobs/7666190003',
      );
      expect(credit?.location?.city).toBe('Remote US');
      expect(credit?.department).toBe('Core Analytics');
      expect(credit?.isRemote).toBe(true);
      // The HTML stripper removes tags but preserves text content.
      expect(credit?.description).not.toContain('<p>');
      expect(credit?.description).toContain('BNPL underwriting decisioning');

      const eng = dto.jobs.find((j) => j.id === 'affirm-7666842004');
      expect(eng?.isRemote).toBe(false);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('Hybrid - San Francisco');

      // Regression guard: the slug must be `affirm` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/affirm/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AffirmService();
      const input: ScraperInputDto = {
        siteType: [Site.AFFIRM],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AffirmService();
      const result = await service.scrape({
        siteType: [Site.AFFIRM],
        searchTerm: 'MERCHANT CHECKOUT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('affirm-7666842004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AffirmService();
      const result = await service.scrape({
        siteType: [Site.AFFIRM],
        searchTerm: 'core analytics',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('affirm-7666190003');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AffirmService();
      const result = await service.scrape({
        siteType: [Site.AFFIRM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AffirmService();
      const result = await service.scrape({
        siteType: [Site.AFFIRM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
