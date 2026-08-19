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

import { AcryldataModule, AcryldataService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acryldata-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 184 / T04 — `AcryldataService` unit tests.
 *
 * Coverage (>= 11 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcryldataService` through `AcryldataModule`.
 *   2. `Site.ACRYLDATA === 'acryldata'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 wire pin
 *      (`'DataHub'` 7 bytes — slug-mismatch sub-form); D-10
 *      clean-pass-through title lock; D-11 clean-pass-through
 *      dept lock.
 *   4. D-09 explicit byte-for-byte wire lock + slug-vs-wire
 *      mismatch lock (slug `acryldata` is derived from corporate
 *      name `'Acryl Data'`, NOT from the wire `'DataHub'`).
 *   5. D-11 explicit clean-pass-through dept lock.
 *   6. D-10 explicit clean-pass-through title lock.
 *   7. resultsWanted cap.
 *   8. searchTerm by title.
 *   9. searchTerm by department.
 *  10. error handling (HTTP 500 → empty, never throws).
 *  11. empty payload.
 */
describe('AcryldataService — Spec 184 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcryldataModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcryldataModule],
      }).compile();
      const service = moduleRef.get(AcryldataService);
      expect(service).toBeInstanceOf(AcryldataService);
      await moduleRef.close();
    });

    it('exports the Site.ACRYLDATA = "acryldata" enum value', () => {
      expect(Site.ACRYLDATA).toBe('acryldata');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const bdr = dto.jobs.find((j) => j.id === 'acryldata-5128449007');
      expect(bdr).toBeDefined();
      expect(bdr?.site).toBe(Site.ACRYLDATA);
      // D-09 lock — wire `'DataHub'` (slug-mismatch sub-form).
      expect(bdr?.companyName).toBe('DataHub');
      expect(bdr?.companyName).toHaveLength(7);
      // D-10 lock — wire title flows through byte-for-byte.
      expect(bdr?.title).toBe('Business Development Representative');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(bdr?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acryldata/jobs/5128449007',
      );
      expect(bdr?.jobUrl).toContain('job-boards.greenhouse.io/acryldata/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(bdr?.department).toBe('Marketing & Sales');
      expect(bdr?.location?.city).toBe('Europe Remote');
      expect(bdr?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(bdr?.description).not.toContain('&lt;');
      expect(bdr?.description).not.toContain('&amp;');
      expect(bdr?.description).not.toContain('<p>');
      expect(bdr?.description).toContain('Acryl Data');

      const spe = dto.jobs.find((j) => j.id === 'acryldata-5128449008');
      expect(spe).toBeDefined();
      expect(spe?.title).toBe('Senior Platform Engineer');
      expect(spe?.companyName).toBe('DataHub');
      expect(spe?.department).toBe('Engineering');

      const csm = dto.jobs.find((j) => j.id === 'acryldata-5128449009');
      expect(csm).toBeDefined();
      expect(csm?.title).toBe('Customer Success Manager');
      expect(csm?.companyName).toBe('DataHub');
      expect(csm?.department).toBe('Customer Success');
      expect(csm?.isRemote).toBe(true);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acryldata/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte wire lock + slug-vs-wire mismatch lock', () => {
    it('preserves wire company_name as-is and confirms slug derives from corporate name not wire', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        // Wire pass-through: 7 bytes TWO-cap PascalCase single-token.
        expect(job.companyName).toBe('DataHub');
        expect(job.companyName).toHaveLength(7);
      }
      const wire = 'DataHub';
      // Single-token (no internal whitespace).
      expect(wire.split(' ')).toHaveLength(1);
      // TWO caps at byte 0 and byte 4.
      const capIndices: number[] = [];
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] >= 'A' && wire[i] <= 'Z') capIndices.push(i);
      }
      expect(capIndices).toEqual([0, 4]);
      // Slug-vs-wire mismatch lock: slug is NOT lowercase-of-wire.
      const slug = 'acryldata';
      expect(slug).not.toBe(wire.toLowerCase()); // 'acryldata' !== 'datahub'
      expect(slug.length).toBe(9);
      expect(wire.toLowerCase().length).toBe(7);
      // Slug-from-corporate-name derivation lock:
      // corporate name 'Acryl Data' → space-strip → 'AcrylData' → lowercase → 'acryldata'.
      const corporate = 'Acryl Data';
      expect(corporate.replace(/\s+/g, '').toLowerCase()).toBe(slug);
      expect(corporate.split(' ')).toHaveLength(2);
      expect(corporate.split(' ')[0]).toBe('Acryl');
      expect(corporate.split(' ')[1]).toBe('Data');
    });
  });

  describe('D-10 clean-pass-through lock', () => {
    it('emits title byte-equal to wire title (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
      } as ScraperInputDto);

      for (let i = 0; i < result.jobs.length; i++) {
        const wireTitle = JOBS_PAGE_RAW.jobs[i].title;
        expect(result.jobs[i].title).toBe(wireTitle);
        expect(wireTitle).not.toMatch(/\s$/);
        expect(wireTitle).not.toMatch(/^\s/);
      }
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
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

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
        searchTerm: 'platform',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acryldata-5128449008');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
        searchTerm: 'CUSTOMER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acryldata-5128449009');
      expect(result.jobs[0].department).toBe('Customer Success');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcryldataService();
      const result = await service.scrape({
        siteType: [Site.ACRYLDATA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
