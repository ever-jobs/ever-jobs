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

import { ShopmonkeyModule, ShopmonkeyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'shopmonkey-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 170 / T04 — `ShopmonkeyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ShopmonkeyService` through `ShopmonkeyModule`.
 *   2. `Site.SHOPMONKEY === 'shopmonkey'` literal pin.
 *   3. Happy path — variant-10 URL pass-through (legacy hosted-
 *      board apex `boards.greenhouse.io/shopmonkey/jobs/<id>?gh_jid=<id>`);
 *      D-09 case-symmetric `'Shopmonkey'` lock; **D-10 OMITTED —
 *      byte-for-byte title pass-through lock** (no `.trim()` on
 *      `listing.title`); D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ShopmonkeyService — Spec 170 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ShopmonkeyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ShopmonkeyModule],
      }).compile();
      const service = moduleRef.get(ShopmonkeyService);
      expect(service).toBeInstanceOf(ShopmonkeyService);
      await moduleRef.close();
    });

    it('exports the Site.SHOPMONKEY = "shopmonkey" enum value', () => {
      expect(Site.SHOPMONKEY).toBe('shopmonkey');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const im = dto.jobs.find((j) => j.id === 'shopmonkey-7681127003');
      expect(im).toBeDefined();
      expect(im?.site).toBe(Site.SHOPMONKEY);
      // D-09 case-symmetric lock.
      expect(im?.companyName).toBe('Shopmonkey');
      expect(im?.companyName?.toLowerCase()).toBe('shopmonkey');
      // D-10 OMITTED lock — wire title is byte-for-byte clean
      // (no leading/trailing whitespace on the wire) and the
      // emitted title equals the wire title byte-for-byte (no
      // `.trim()` operation).
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Implementation Manager');
      expect(JOBS_PAGE_RAW.jobs[0].title).not.toMatch(/^\s/);
      expect(JOBS_PAGE_RAW.jobs[0].title).not.toMatch(/\s$/);
      expect(im?.title).toBe('Implementation Manager');
      expect(im?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock — variant 10 (legacy hosted-board apex).
      expect(im?.jobUrl).toBe(
        'https://boards.greenhouse.io/shopmonkey/jobs/7681127003?gh_jid=7681127003',
      );
      expect(im?.jobUrl).toContain('boards.greenhouse.io/shopmonkey/jobs/');
      expect(im?.jobUrl).toContain('?gh_jid=7681127003');
      expect(im?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(im?.department).toBe('Implementation');
      expect(im?.location?.city).toBe('Hybrid - Morgan Hill, California');
      expect(im?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(im?.description).not.toContain('&lt;');
      expect(im?.description).not.toContain('&amp;');
      expect(im?.description).not.toContain('<p>');
      expect(im?.description).not.toContain('<strong>');
      expect(im?.description).toContain('Shopmonkey');

      const sse = dto.jobs.find((j) => j.id === 'shopmonkey-7603071003');
      expect(sse).toBeDefined();
      // D-10 OMITTED — clean title byte-for-byte.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Software Engineer, Platform');
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      expect(sse?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(sse?.companyName).toBe('Shopmonkey');
      expect(sse?.location?.city).toBe('Remote, US');
      expect(sse?.isRemote).toBe(true);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://boards.greenhouse.io/shopmonkey/jobs/7603071003?gh_jid=7603071003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/shopmonkey/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
        searchTerm: 'IMPLEMENTATION',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('shopmonkey-7681127003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('shopmonkey-7603071003');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ShopmonkeyService();
      const result = await service.scrape({
        siteType: [Site.SHOPMONKEY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
