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

import { DollarShaveClubModule, DollarShaveClubService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'dollarshaveclub-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 096 / T04 — `DollarShaveClubService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DollarShaveClubService` through `DollarShaveClubModule`.
 *   2. `Site.DOLLARSHAVECLUB === 'dollarshaveclub'` literal pin.
 *   3. Happy path — variant-2 URL pass-through (canonical
 *      Greenhouse host); D-09 THREE-token internal-whitespace-
 *      asymmetry wire `'Dollar Shave Club'` byte-for-byte (first
 *      cohort observation of three-token form); D-10 omission
 *      (clean wire titles); D-11 application with `'Legal '` →
 *      `'Legal'` trim (first cohort plugin to combine D-11 with
 *      D-09 internal-whitespace asymmetry).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DollarShaveClubService — Spec 096 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DollarShaveClubModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DollarShaveClubModule],
      }).compile();
      const service = moduleRef.get(DollarShaveClubService);
      expect(service).toBeInstanceOf(DollarShaveClubService);
      await moduleRef.close();
    });

    it('exports the Site.DOLLARSHAVECLUB = "dollarshaveclub" enum value', () => {
      expect(Site.DOLLARSHAVECLUB).toBe('dollarshaveclub');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bm = dto.jobs.find((j) => j.id === 'dollarshaveclub-4672188006');
      expect(bm).toBeDefined();
      expect(bm?.site).toBe(Site.DOLLARSHAVECLUB);
      // **D-09 lock — first-cohort THREE-token internal-
      // whitespace-asymmetry wire form**: emitted `companyName
      // === 'Dollar Shave Club'` byte-for-byte (17 bytes — two
      // internal ASCII spaces between three brand-tokens). The
      // wire is byte-distinct from the concatenated 15-byte
      // slug `'dollarshaveclub'` and from the title-cased
      // concatenated form `'DollarShaveClub'`.
      expect(bm?.companyName).toBe('Dollar Shave Club');
      expect(bm?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(bm?.companyName?.length).toBe(17);
      expect(bm?.companyName).toContain('Dollar Shave');
      expect(bm?.companyName).toContain('Shave Club');
      expect(bm?.companyName).not.toBe('dollarshaveclub');
      expect(bm?.companyName).not.toBe('DollarShaveClub');
      // D-10 lock — wire-title pass-through (D-10 OMITTED): wire
      // title `'Brand Marketing Intern'` is clean (no pad bytes)
      // and emits byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Brand Marketing Intern');
      expect(bm?.title).toBe('Brand Marketing Intern');
      expect(bm?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(bm?.title).not.toMatch(/^\s/);
      expect(bm?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 2 (canonical Greenhouse host)**:
      // emitted `jobUrl` byte-for-byte; contains
      // `job-boards.greenhouse.io/dollarshaveclub/jobs/`; does
      // NOT contain `www.dollarshaveclub.com` (locks variant 2
      // against accidental vanity-domain construction).
      expect(bm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/dollarshaveclub/jobs/4672188006',
      );
      expect(bm?.jobUrl).toContain(
        'job-boards.greenhouse.io/dollarshaveclub/jobs/',
      );
      expect(bm?.jobUrl).not.toContain('www.dollarshaveclub.com');
      // D-11 lock — clean wire department on listing 1: `'Brand
      // Strategy & Marketing'` is unpadded; emit byte-for-byte
      // (the trim is a no-op on already-clean wire forms).
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe(
        'Brand Strategy & Marketing',
      );
      expect(bm?.department).toBe('Brand Strategy & Marketing');
      expect(bm?.location?.city).toBe('Durham, North Carolina');
      expect(bm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(bm?.description).not.toContain('&lt;');
      expect(bm?.description).not.toContain('&amp;');
      expect(bm?.description).not.toContain('<p>');
      expect(bm?.description).not.toContain('<strong>');
      expect(bm?.description).toContain('Dollar Shave Club');

      const lg = dto.jobs.find((j) => j.id === 'dollarshaveclub-4672180006');
      expect(lg).toBeDefined();
      expect(lg?.title).toBe('Legal Intern');
      expect(lg?.companyName).toBe('Dollar Shave Club');
      expect(lg?.location?.city).toBe('Remote, United States');
      expect(lg?.isRemote).toBe(true);
      // **D-11 lock — single-trailing-space form**: input
      // `departments[0].name === 'Legal '` (6 bytes; one
      // trailing ASCII space) → emitted `department === 'Legal'`
      // (5 bytes; byte-distinct + 1-byte-shorter; does NOT end
      // in whitespace).
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Legal ');
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name.length).toBe(6);
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name.charCodeAt(5)).toBe(32); // ASCII space
      expect(lg?.department).toBe('Legal');
      expect(lg?.department?.length).toBe(5);
      expect(lg?.department).not.toBe('Legal ');
      expect(lg?.department).not.toMatch(/\s$/);
      expect(lg?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/dollarshaveclub/jobs/4672180006',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/dollarshaveclub/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
        searchTerm: 'BRAND',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dollarshaveclub-4672188006');
      expect(result.jobs[0].title).toBe('Brand Marketing Intern');
    });

    it('filters by case-insensitive substring of TRIMMED department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
        searchTerm: 'legal',
      } as ScraperInputDto);

      // D-11 lock — searchTerm hits the TRIMMED department
      // form. Wire `'Legal '` → trimmed `'Legal'` → matches
      // `searchTerm: 'legal'` case-insensitively.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dollarshaveclub-4672180006');
      expect(result.jobs[0].department).toBe('Legal');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DollarShaveClubService();
      const result = await service.scrape({
        siteType: [Site.DOLLARSHAVECLUB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
