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

import { AcommerceModule, AcommerceService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acommerce-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 180 / T04 — `AcommerceService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcommerceService` through `AcommerceModule`.
 *   2. `Site.ACOMMERCE === 'acommerce'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      camelCase ONE-cap-at-byte-1 wire pin** (`'aCommerce'`
 *      9 bytes; single wire-token; byte 0 `'a'` lowercase,
 *      byte 1 `'C'` cap, bytes 2-8 `'ommerce'` lowercase;
 *      slug `acommerce` is byte-for-byte lowercase of wire);
 *      D-10 trailing-pad title-trim lock; D-11 clean-pass-
 *      through dept lock.
 *   4. D-09 explicit byte-for-byte lock (single-token
 *      camelCase ONE-cap-at-byte-1 slug-derivation).
 *   5. D-11 explicit clean-pass-through dept lock (every
 *      emitted `department` byte-equals wire
 *      `departments[0].name`).
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcommerceService — Spec 180 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcommerceModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcommerceModule],
      }).compile();
      const service = moduleRef.get(AcommerceService);
      expect(service).toBeInstanceOf(AcommerceService);
      await moduleRef.close();
    });

    it('exports the Site.ACOMMERCE = "acommerce" enum value', () => {
      expect(Site.ACOMMERCE).toBe('acommerce');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const kam = dto.jobs.find((j) => j.id === 'acommerce-7382874');
      expect(kam).toBeDefined();
      expect(kam?.site).toBe(Site.ACOMMERCE);
      // D-09 lock — wire is single-token camelCase
      // ONE-cap-at-byte-1; slug is byte-for-byte lowercase.
      expect(kam?.companyName).toBe('aCommerce');
      expect(kam?.companyName).toHaveLength(9);
      // D-10 lock — wire title carries trailing-pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Key Account Manager ');
      expect(kam?.title).toBe('Key Account Manager');
      expect(kam?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(kam?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acommerce/jobs/7382874',
      );
      expect(kam?.jobUrl).toContain('job-boards.greenhouse.io/acommerce/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(kam?.department).toBe('Key Account Management');
      expect(kam?.location?.city).toBe('Bangkok, Thailand');
      expect(kam?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(kam?.description).not.toContain('&lt;');
      expect(kam?.description).not.toContain('&amp;');
      expect(kam?.description).not.toContain('<p>');
      expect(kam?.description).toContain('aCommerce');

      const ai = dto.jobs.find((j) => j.id === 'acommerce-7742400');
      expect(ai).toBeDefined();
      expect(ai?.title).toBe('AI Solutions Manager / Technical Sales (E-commerce)');
      expect(ai?.companyName).toBe('aCommerce');
      expect(ai?.department).toBe('Business Development');
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acommerce/jobs/7742400',
      );

      const bd = dto.jobs.find((j) => j.id === 'acommerce-6512630');
      expect(bd).toBeDefined();
      expect(bd?.title).toBe('Associate Business Development Manager');
      expect(bd?.companyName).toBe('aCommerce');
      expect(bd?.department).toBe('Business Development');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acommerce/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (single-token camelCase ONE-cap-at-byte-1 slug-derivation)', () => {
    it('preserves wire company_name as-is — single-token camelCase classical (lowercase-prefix + cap-at-byte-1 + lowercase-tail)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('aCommerce');
        expect(job.companyName).toHaveLength(9);
      }
      const wire = 'aCommerce';
      // Wire is a single token — no internal whitespace.
      expect(wire.split(' ')).toHaveLength(1);
      // Byte-by-byte invariants:
      expect(wire[0]).toBe('a');              // byte 0 lowercase
      expect(wire[1]).toBe('C');              // byte 1 cap (sole)
      expect(wire.slice(2)).toBe('ommerce');  // bytes 2-8 lowercase tail
      // Cap-at-byte-1-only invariant: exactly ONE uppercase
      // letter in the whole wire-token, and it sits at index 1.
      const capIndices: number[] = [];
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] >= 'A' && wire[i] <= 'Z') capIndices.push(i);
      }
      expect(capIndices).toEqual([1]);
      // Slug is byte-for-byte lowercase of wire.
      const slug = wire.toLowerCase();
      expect(slug).toBe('acommerce');
      expect(slug).toHaveLength(9);
      // Slug appears as a substring of the lowercased wire
      // (single-token camelCase classical guarantee).
      expect(wire.toLowerCase()).toContain(slug);
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
      } as ScraperInputDto);

      for (let i = 0; i < result.jobs.length; i++) {
        const wireDept = JOBS_PAGE_RAW.jobs[i].departments[0].name;
        expect(result.jobs[i].department).toBe(wireDept);
        // No padding present in fixture (D-11 omitted form).
        expect(wireDept).not.toMatch(/\s$/);
        expect(wireDept).not.toMatch(/^\s/);
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
        searchTerm: 'associate',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acommerce-6512630');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
        searchTerm: 'KEY ACCOUNT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acommerce-7382874');
      expect(result.jobs[0].department).toBe('Key Account Management');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcommerceService();
      const result = await service.scrape({
        siteType: [Site.ACOMMERCE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
