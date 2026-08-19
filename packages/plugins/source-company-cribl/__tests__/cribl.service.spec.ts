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

import { CriblModule, CriblService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cribl-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 143 / T04 — `CriblService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CriblService` through `CriblModule`.
 *   2. `Site.CRIBL === 'cribl'` literal pin.
 *   3. Happy path — **variant-38 URL byte-for-byte lock**
 *      (`cribl.io/job-detail/?gh_jid=<id>` `.io`-TLD bare brand
 *      with NO `/careers/` ancestor); D-09 case-symmetric
 *      `'Cribl'` lock; D-10 omitted byte-for-byte title pass-
 *      through (no trim) lock; D-11 clean dept pass-through
 *      lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CriblService — Spec 143 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CriblModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CriblModule],
      }).compile();
      const service = moduleRef.get(CriblService);
      expect(service).toBeInstanceOf(CriblService);
      await moduleRef.close();
    });

    it('exports the Site.CRIBL = "cribl" enum value', () => {
      expect(Site.CRIBL).toBe('cribl');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ch = dto.jobs.find((j) => j.id === 'cribl-5826710004');
      expect(ch).toBeDefined();
      expect(ch?.site).toBe(Site.CRIBL);
      // D-09 case-symmetric lock.
      expect(ch?.companyName).toBe('Cribl');
      expect(ch?.companyName?.toLowerCase()).toBe('cribl');
      // D-10 omitted — title byte-for-byte pass-through.
      expect(ch?.title).toBe('Channel Sales Manager');
      // D-04 lock — variant 38 (.io TLD bare brand + /job-detail/
      // + query-only-id, NO /careers/ ancestor).
      expect(ch?.jobUrl).toBe(
        'https://cribl.io/job-detail/?gh_jid=5826710004',
      );
      expect(ch?.jobUrl).toContain('cribl.io/job-detail/');
      expect(ch?.jobUrl).not.toContain('/careers/');
      expect(ch?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(ch?.department).toBe('Sales');
      expect(ch?.location?.city).toBe('Remote, US');
      expect(ch?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ch?.description).not.toContain('&lt;');
      expect(ch?.description).not.toContain('<p>');
      expect(ch?.description).toContain('Cribl');

      const eng = dto.jobs.find((j) => j.id === 'cribl-5842537004');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Senior Software Engineer, Cribl Stream');
      expect(eng?.companyName).toBe('Cribl');
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.isRemote).toBe(false);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.jobUrl).toBe(
        'https://cribl.io/job-detail/?gh_jid=5842537004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/cribl/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cribl-5842537004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
        searchTerm: 'sales',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('cribl-5826710004');
      expect(result.jobs[0].department).toBe('Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CriblService();
      const result = await service.scrape({
        siteType: [Site.CRIBL],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
