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

import { QuanataModule, QuanataService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'quanata-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 166 / T04 — `QuanataService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `QuanataService` through `QuanataModule`.
 *   2. `Site.QUANATA === 'quanata'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Quanata'` lock; **D-10 leading-pad title-
 *      trim lock** (9th cohort observation of leading-pad
 *      sub-axis); D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('QuanataService — Spec 166 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through QuanataModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [QuanataModule],
      }).compile();
      const service = moduleRef.get(QuanataService);
      expect(service).toBeInstanceOf(QuanataService);
      await moduleRef.close();
    });

    it('exports the Site.QUANATA = "quanata" enum value', () => {
      expect(Site.QUANATA).toBe('quanata');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sa = dto.jobs.find((j) => j.id === 'quanata-5837465004');
      expect(sa).toBeDefined();
      expect(sa?.site).toBe(Site.QUANATA);
      // D-09 case-symmetric lock.
      expect(sa?.companyName).toBe('Quanata');
      expect(sa?.companyName?.toLowerCase()).toBe('quanata');
      // **D-10 leading-pad sub-axis lock** — 9th cohort
      // observation. Wire title carries leading-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(' Staff Accountant [Remote-US]');
      expect(sa?.title).toBe('Staff Accountant [Remote-US]');
      expect(sa?.title).not.toMatch(/^\s/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(sa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/quanata/jobs/5837465004',
      );
      expect(sa?.jobUrl).toContain('job-boards.greenhouse.io/quanata/jobs/');
      // D-11 clean dept pass-through.
      expect(sa?.department).toBe('Finance');
      expect(sa?.location?.city).toBe('Remote, US');
      expect(sa?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(sa?.description).not.toContain('&lt;');
      expect(sa?.description).not.toContain('&amp;');
      expect(sa?.description).not.toContain('<p>');
      expect(sa?.description).not.toContain('<strong>');
      expect(sa?.description).toContain('Quanata');

      const ac = dto.jobs.find((j) => j.id === 'quanata-5826032004');
      expect(ac).toBeDefined();
      expect(ac?.title).toBe('Actuary [Remote-US]');
      expect(ac?.companyName).toBe('Quanata');
      expect(ac?.location?.city).toBe('Remote, US');
      expect(ac?.isRemote).toBe(true);
      // D-11 clean dept pass-through (long internal-whitespace
      // multi-token form preserved byte-for-byte).
      expect(ac?.department).toBe('Actuarial Operations and Risk Management');
      expect(ac?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/quanata/jobs/5826032004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/quanata/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
        searchTerm: 'ACCOUNTANT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('quanata-5837465004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
        searchTerm: 'actuarial',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('quanata-5826032004');
      expect(result.jobs[0].department).toBe('Actuarial Operations and Risk Management');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new QuanataService();
      const result = await service.scrape({
        siteType: [Site.QUANATA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
