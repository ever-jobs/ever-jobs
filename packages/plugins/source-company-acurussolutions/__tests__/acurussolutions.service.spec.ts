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

import { AcurussolutionsModule, AcurussolutionsService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acurussolutions-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 186 / T04 — `AcurussolutionsService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcurussolutionsService` through `AcurussolutionsModule`.
 *   2. `Site.ACURUSSOLUTIONS === 'acurussolutions'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 4-token
 *      PascalCase byte-for-byte wire pin
 *      (`'Acurus Solutions Private Limited'` 32 bytes);
 *      D-10 trailing-pad title-trim lock; D-11 clean dept
 *      pass-through lock.
 *   4. D-09 explicit byte-for-byte 4-token PascalCase wire
 *      lock + slug-truncation derivation lock (drop
 *      `'Private Limited'` legal suffix; keep first-2-
 *      tokens `'Acurus Solutions'`; space-strip + lowercase
 *      → 15-byte slug `acurussolutions`).
 *   5. D-10 explicit trailing-pad title-trim lock (no emitted
 *      title ends in whitespace).
 *   6. D-11 explicit clean-pass-through dept lock.
 *   7..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcurussolutionsService — Spec 186 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcurussolutionsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcurussolutionsModule],
      }).compile();
      const service = moduleRef.get(AcurussolutionsService);
      expect(service).toBeInstanceOf(AcurussolutionsService);
      await moduleRef.close();
    });

    it('exports the Site.ACURUSSOLUTIONS = "acurussolutions" enum value', () => {
      expect(Site.ACURUSSOLUTIONS).toBe('acurussolutions');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const hr = dto.jobs.find((j) => j.id === 'acurussolutions-4660650006');
      expect(hr).toBeDefined();
      expect(hr?.site).toBe(Site.ACURUSSOLUTIONS);
      // D-09 4-token PascalCase wire lock.
      expect(hr?.companyName).toBe('Acurus Solutions Private Limited');
      expect(hr?.companyName).toHaveLength(32);
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Junior HR and Admin Coordinator ');
      expect(hr?.title).toBe('Junior HR and Admin Coordinator');
      expect(hr?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(hr?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acurussolutions/jobs/4660650006',
      );
      expect(hr?.jobUrl).toContain('job-boards.greenhouse.io/acurussolutions/jobs/');
      // D-11 clean dept pass-through.
      expect(hr?.department).toBe('People');
      expect(hr?.location?.city).toBe('Bengaluru, Karnataka, India');
      expect(hr?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(hr?.description).not.toContain('&lt;');
      expect(hr?.description).not.toContain('&amp;');
      expect(hr?.description).not.toContain('<p>');
      expect(hr?.description).toContain('Acurus Solutions');

      const ar = dto.jobs.find((j) => j.id === 'acurussolutions-4011768006');
      expect(ar).toBeDefined();
      expect(ar?.title).toBe('AR Analyst');
      expect(ar?.companyName).toBe('Acurus Solutions Private Limited');
      expect(ar?.department).toBe('Revenue Cycle Management');

      const kat = dto.jobs.find((j) => j.id === 'acurussolutions-4011503006');
      expect(kat).toBeDefined();
      expect(kat?.title).toBe('Knowledge Associate Trainee');
      expect(kat?.companyName).toBe('Acurus Solutions Private Limited');
      expect(kat?.department).toBe('Health Information Management');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acurussolutions/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock + slug-truncation derivation lock', () => {
    it('preserves wire company_name byte-for-byte — 4-token PascalCase 32-byte wire form', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Acurus Solutions Private Limited');
        expect(job.companyName).toHaveLength(32);
      }
      const wire = 'Acurus Solutions Private Limited';
      // 4 wire tokens.
      const tokens = wire.split(' ');
      expect(tokens).toHaveLength(4);
      expect(tokens).toEqual(['Acurus', 'Solutions', 'Private', 'Limited']);
      // Every token PascalCase cap-at-byte-0-only.
      for (const tok of tokens) {
        expect(tok[0]).toMatch(/[A-Z]/);
        expect(tok.slice(1)).toMatch(/^[a-z]+$/);
      }
      // Slug derivation: drop last-2-tokens (`'Private Limited'`
      // corporate-legal-entity suffix), keep first-2-tokens
      // (`'Acurus Solutions'`), then space-strip + lowercase.
      const firstTwo = tokens.slice(0, 2).join(' ');
      expect(firstTwo).toBe('Acurus Solutions');
      expect(firstTwo).toHaveLength(16);
      const slug = firstTwo.replace(/ /g, '').toLowerCase();
      expect(slug).toBe('acurussolutions');
      expect(slug).toHaveLength(15);
    });
  });

  describe('D-10 trailing-pad title-trim lock', () => {
    it('trims trailing ASCII-space padding from wire titles — no emitted title ends in whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
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

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
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

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
        searchTerm: 'analyst',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acurussolutions-4011768006');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
        searchTerm: 'HEALTH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acurussolutions-4011503006');
      expect(result.jobs[0].department).toBe('Health Information Management');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcurussolutionsService();
      const result = await service.scrape({
        siteType: [Site.ACURUSSOLUTIONS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
