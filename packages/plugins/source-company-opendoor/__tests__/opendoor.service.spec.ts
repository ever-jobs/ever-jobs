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

import { OpendoorModule, OpendoorService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'opendoor-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 132 / T04 — `OpendoorService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `OpendoorService` through `OpendoorModule`.
 *   2. `Site.OPENDOOR === 'opendoor'` literal pin.
 *   3. Happy path — variant-34 URL pass-through (first cohort
 *      observation of HTTPS `www.opendoor.com/careers/open-
 *      positions` query-only-id); D-09 case-symmetric lock;
 *      **D-10 first-cohort internal-double-whitespace
 *      observation** lock (`'Customer Experience  Specialist '`
 *      → `'Customer Experience  Specialist'` — internal
 *      anomaly preserved); D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('OpendoorService — Spec 132 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through OpendoorModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [OpendoorModule],
      }).compile();
      const service = moduleRef.get(OpendoorService);
      expect(service).toBeInstanceOf(OpendoorService);
      await moduleRef.close();
    });

    it('exports the Site.OPENDOOR = "opendoor" enum value', () => {
      expect(Site.OPENDOOR).toBe('opendoor');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ces = dto.jobs.find((j) => j.id === 'opendoor-4644592006');
      expect(ces).toBeDefined();
      expect(ces?.site).toBe(Site.OPENDOOR);
      // D-09 case-symmetric lock.
      expect(ces?.companyName).toBe('Opendoor');
      expect(ces?.companyName?.toLowerCase()).toBe('opendoor');
      // **D-10 lock — FIRST-COHORT internal-double-whitespace
      // sub-axis**: wire title carries trailing-space pad
      // AND internal double-space anomaly. Emitted: trailing
      // trimmed, internal preserved.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Customer Experience  Specialist ');
      expect(ces?.title).toBe('Customer Experience  Specialist');
      expect(ces?.title).not.toMatch(/\s$/);
      // Internal anomaly preserved byte-for-byte.
      expect(ces?.title).toMatch(/Experience  Specialist/);
      // **D-04 lock — variant 34 (first cohort observation of
      // HTTPS `www.opendoor.com/careers/open-positions`
      // query-only-id).**
      expect(ces?.jobUrl).toBe(
        'https://www.opendoor.com/careers/open-positions?gh_jid=4644592006',
      );
      expect(ces?.jobUrl).toMatch(/^https:\/\//);
      expect(ces?.jobUrl).toContain('www.opendoor.com/careers/open-positions');
      expect(ces?.jobUrl).toContain('?gh_jid=4644592006');
      expect(ces?.jobUrl).not.toContain('greenhouse.io');
      expect(ces?.department).toBe('Sales & Support');
      expect(ces?.location?.city).toBe('Phoenix, AZ');
      expect(ces?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ces?.description).not.toContain('&lt;');
      expect(ces?.description).not.toContain('&amp;');
      expect(ces?.description).not.toContain('<p>');
      expect(ces?.description).not.toContain('<strong>');
      expect(ces?.description).toContain('Opendoor');

      const sse = dto.jobs.find((j) => j.id === 'opendoor-4789315002');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Marketplace');
      expect(sse?.companyName).toBe('Opendoor');
      expect(sse?.location?.city).toBe('San Francisco, CA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://www.opendoor.com/careers/open-positions?gh_jid=4789315002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/opendoor/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
        searchTerm: 'MARKETPLACE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('opendoor-4789315002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
        searchTerm: 'sales & support',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('opendoor-4644592006');
      expect(result.jobs[0].department).toBe('Sales & Support');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new OpendoorService();
      const result = await service.scrape({
        siteType: [Site.OPENDOOR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
