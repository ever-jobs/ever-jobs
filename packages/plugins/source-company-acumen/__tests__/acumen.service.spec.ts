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

import { AcumenModule, AcumenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acumen-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 185 / T04 — `AcumenService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcumenService` through `AcumenModule`.
 *   2. `Site.ACUMEN === 'acumen'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric bare-brand wire pin (`'Acumen'` 6 bytes,
 *      single-token PascalCase); D-10 trailing-pad title-
 *      trim lock; D-11 clean dept pass-through lock.
 *   4. D-09 explicit byte-for-byte lock (case-symmetric bare-
 *      brand PascalCase single-token; slug = byte-for-byte
 *      lowercase of wire).
 *   5. D-10 explicit trailing-pad title-trim lock (no emitted
 *      title ends in whitespace).
 *   6. D-11 explicit clean-pass-through dept lock.
 *   7..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcumenService — Spec 185 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcumenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcumenModule],
      }).compile();
      const service = moduleRef.get(AcumenService);
      expect(service).toBeInstanceOf(AcumenService);
      await moduleRef.close();
    });

    it('exports the Site.ACUMEN = "acumen" enum value', () => {
      expect(Site.ACUMEN).toBe('acumen');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const cc = dto.jobs.find((j) => j.id === 'acumen-8533135002');
      expect(cc).toBeDefined();
      expect(cc?.site).toBe(Site.ACUMEN);
      // D-09 case-symmetric bare-brand wire lock.
      expect(cc?.companyName).toBe('Acumen');
      expect(cc?.companyName).toHaveLength(6);
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Compensation Consultant ');
      expect(cc?.title).toBe('Compensation Consultant');
      expect(cc?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(cc?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acumen/jobs/8533135002',
      );
      expect(cc?.jobUrl).toContain('job-boards.greenhouse.io/acumen/jobs/');
      // D-11 clean dept pass-through.
      expect(cc?.department).toBe('Talent');
      expect(cc?.location?.city).toBe('New York City');
      expect(cc?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(cc?.description).not.toContain('&lt;');
      expect(cc?.description).not.toContain('&amp;');
      expect(cc?.description).not.toContain('<p>');
      expect(cc?.description).toContain('Acumen');

      const im = dto.jobs.find((j) => j.id === 'acumen-8452181002');
      expect(im).toBeDefined();
      expect(im?.title).toBe('Investment Manager, Acumen India');
      expect(im?.companyName).toBe('Acumen');
      expect(im?.department).toBe('Investing');
      expect(im?.location?.city).toBe('Mumbai, India');

      const dsm = dto.jobs.find((j) => j.id === 'acumen-8499399002');
      expect(dsm).toBeDefined();
      expect(dsm?.title).toBe('Data Systems Manager');
      expect(dsm?.companyName).toBe('Acumen');
      expect(dsm?.department).toBe('Acumen Academy');
      expect(dsm?.location?.city).toBe('Colombia');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acumen/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (case-symmetric bare-brand)', () => {
    it('preserves wire company_name as-is — single-token PascalCase, slug is byte-for-byte lowercase', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Acumen');
        expect(job.companyName).toHaveLength(6);
      }
      const wire = 'Acumen';
      // Single-token (no internal whitespace).
      expect(wire.split(' ')).toHaveLength(1);
      // Cap at byte 0 only.
      expect(wire[0]).toBe('A');
      expect(wire.slice(1)).toBe('cumen');
      const capIndices: number[] = [];
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] >= 'A' && wire[i] <= 'Z') capIndices.push(i);
      }
      expect(capIndices).toEqual([0]);
      // Slug byte-for-byte lowercase of wire.
      expect(wire.toLowerCase()).toBe('acumen');
    });
  });

  describe('D-10 trailing-pad title-trim lock', () => {
    it('trims trailing ASCII-space padding from wire titles — no emitted title ends in whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
      } as ScraperInputDto);

      // Wire fixture carries the padded form on listing[0].
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/\s$/);
      // Emitted titles are all .trim()'d.
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/\s$/);
        expect(job.title).not.toMatch(/^\s/);
      }
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
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

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
        searchTerm: 'investment',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acumen-8452181002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
        searchTerm: 'ACADEMY',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acumen-8499399002');
      expect(result.jobs[0].department).toBe('Acumen Academy');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcumenService();
      const result = await service.scrape({
        siteType: [Site.ACUMEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
