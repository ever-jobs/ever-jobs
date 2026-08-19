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

import { AcquiaModule, AcquiaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acquia-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 182 / T04 — `AcquiaService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcquiaService` through `AcquiaModule`.
 *   2. `Site.ACQUIA === 'acquia'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 bare-
 *      brand wire pin (`'Acquia'` 6 bytes); D-10 clean-pass-
 *      through title lock; D-11 clean-pass-through dept lock.
 *   4. D-09 explicit byte-for-byte lock (case-symmetric bare-
 *      brand PascalCase single-token).
 *   5. D-11 explicit clean-pass-through dept lock.
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcquiaService — Spec 182 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcquiaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcquiaModule],
      }).compile();
      const service = moduleRef.get(AcquiaService);
      expect(service).toBeInstanceOf(AcquiaService);
      await moduleRef.close();
    });

    it('exports the Site.ACQUIA = "acquia" enum value', () => {
      expect(Site.ACQUIA).toBe('acquia');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const ae = dto.jobs.find((j) => j.id === 'acquia-7289164');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.ACQUIA);
      // D-09 lock — bare-brand single-token PascalCase.
      expect(ae?.companyName).toBe('Acquia');
      expect(ae?.companyName).toHaveLength(6);
      // D-10 lock — wire title flows through byte-for-byte.
      expect(ae?.title).toBe('Account Executive');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acquia/jobs/7289164',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/acquia/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(ae?.department).toBe('Sales');
      expect(ae?.location?.city).toBe('Remote - United States');
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).toContain('Acquia');

      const dr = dto.jobs.find((j) => j.id === 'acquia-7859184');
      expect(dr).toBeDefined();
      expect(dr?.title).toBe('Director of Developer Relations & Technical Content');
      expect(dr?.companyName).toBe('Acquia');
      expect(dr?.department).toBe('Marketing');

      const dpm = dto.jobs.find((j) => j.id === 'acquia-7913589');
      expect(dpm).toBeDefined();
      expect(dpm?.title).toBe('Director, Product Management');
      expect(dpm?.companyName).toBe('Acquia');
      expect(dpm?.department).toBe('Products');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acquia/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (case-symmetric bare-brand)', () => {
    it('preserves wire company_name as-is — single-token PascalCase, slug is byte-for-byte lowercase', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Acquia');
        expect(job.companyName).toHaveLength(6);
      }
      const wire = 'Acquia';
      // Single-token (no internal whitespace).
      expect(wire.split(' ')).toHaveLength(1);
      // Cap at byte 0 only.
      expect(wire[0]).toBe('A');
      expect(wire.slice(1)).toBe('cquia');
      const capIndices: number[] = [];
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] >= 'A' && wire[i] <= 'Z') capIndices.push(i);
      }
      expect(capIndices).toEqual([0]);
      // Slug byte-for-byte lowercase of wire.
      expect(wire.toLowerCase()).toBe('acquia');
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
      } as ScraperInputDto);

      for (let i = 0; i < result.jobs.length; i++) {
        const wireDept = JOBS_PAGE_RAW.jobs[i].departments[0].name;
        expect(result.jobs[i].department).toBe(wireDept);
        expect(wireDept).not.toMatch(/\s$/);
        expect(wireDept).not.toMatch(/^\s/);
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
        searchTerm: 'developer',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acquia-7859184');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
        searchTerm: 'PRODUCTS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acquia-7913589');
      expect(result.jobs[0].department).toBe('Products');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcquiaService();
      const result = await service.scrape({
        siteType: [Site.ACQUIA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
