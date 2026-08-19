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

import { AckermannGroupModule, AckermannGroupService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'ackermanngroup-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 177 / T04 — `AckermannGroupService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AckermannGroupService` through
 *      `AckermannGroupModule`.
 *   2. `Site.ACKERMANNGROUP === 'ackermanngroup'` literal pin.
 *   3. Happy path — variant-10 URL pass-through (legacy
 *      hosted-board apex
 *      `boards.greenhouse.io/ackermanngroup/jobs/<id>?gh_jid=<id>`);
 *      **D-09 two-token PascalCase + space-strip wire pin**
 *      (`'Ackermann Group'` 15 bytes; first token `Ackermann`
 *      9 bytes PascalCase cap at index 0; second token `Group`
 *      5 bytes PascalCase cap at index 0; space-strip to slug
 *      `ackermanngroup`); D-10 clean title pass-through lock;
 *      **D-11 completely-absent-departments lock** (all
 *      emitted `department === null`).
 *   4. D-09 explicit byte-for-byte lock (PascalCase +
 *      PascalCase + space-strip co-pattern).
 *   5. D-11 completely-absent-departments lock.
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AckermannGroupService — Spec 177 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AckermannGroupModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AckermannGroupModule],
      }).compile();
      const service = moduleRef.get(AckermannGroupService);
      expect(service).toBeInstanceOf(AckermannGroupService);
      await moduleRef.close();
    });

    it('exports the Site.ACKERMANNGROUP = "ackermanngroup" enum value', () => {
      expect(Site.ACKERMANNGROUP).toBe('ackermanngroup');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const ac = dto.jobs.find((j) => j.id === 'ackermanngroup-5157287008');
      expect(ac).toBeDefined();
      expect(ac?.site).toBe(Site.ACKERMANNGROUP);
      // D-09 lock — wire is PascalCase + PascalCase + space-strip.
      expect(ac?.companyName).toBe('Ackermann Group');
      expect(ac?.companyName).toHaveLength(15);
      // D-10 lock — wire title carries no padding; emitted
      // title pass-through (no `.trim()`).
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Accountant');
      expect(ac?.title).toBe('Accountant');
      expect(ac?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 10 (legacy hosted-board apex).
      expect(ac?.jobUrl).toBe(
        'https://boards.greenhouse.io/ackermanngroup/jobs/5157287008?gh_jid=5157287008',
      );
      expect(ac?.jobUrl).toContain('boards.greenhouse.io/ackermanngroup/jobs/');
      expect(ac?.jobUrl).toContain('?gh_jid=5157287008');
      // D-11 completely-absent-departments lock for this listing.
      expect(ac?.department).toBeNull();
      expect(ac?.location?.city).toBe('Cincinnati, OH');
      expect(ac?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ac?.description).not.toContain('&lt;');
      expect(ac?.description).not.toContain('&amp;');
      expect(ac?.description).not.toContain('<p>');
      expect(ac?.description).toContain('Ackermann Group');

      const cm = dto.jobs.find((j) => j.id === 'ackermanngroup-5204623008');
      expect(cm).toBeDefined();
      expect(cm?.title).toBe('Community Manager - Britton Woods Apartments');
      expect(cm?.companyName).toBe('Ackermann Group');
      expect(cm?.location?.city).toBe('Dublin, OH');
      expect(cm?.isRemote).toBe(false);
      expect(cm?.department).toBeNull();
      expect(cm?.jobUrl).toBe(
        'https://boards.greenhouse.io/ackermanngroup/jobs/5204623008?gh_jid=5204623008',
      );

      const lc = dto.jobs.find((j) => j.id === 'ackermanngroup-5165288008');
      expect(lc).toBeDefined();
      expect(lc?.title).toBe('Leasing Consultant - Britton Woods Apartments');
      expect(lc?.companyName).toBe('Ackermann Group');
      expect(lc?.location?.city).toBe('Dublin, OH');
      expect(lc?.isRemote).toBe(false);
      expect(lc?.department).toBeNull();

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/ackermanngroup/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (PascalCase + PascalCase + space-strip)', () => {
    it('preserves wire company_name as-is — caps at 0 of each of 2 tokens + 1 space stripped to slug', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Ackermann Group');
        expect(job.companyName).toHaveLength(15);
      }
      // PascalCase cap at index 0 of each of the 2 wire tokens.
      const tokens = 'Ackermann Group'.split(' ');
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe('Ackermann');
      expect(tokens[0].charAt(0)).toBe('A');
      expect(tokens[0]).toHaveLength(9);
      expect(tokens[1]).toBe('Group');
      expect(tokens[1].charAt(0)).toBe('G');
      expect(tokens[1]).toHaveLength(5);
      // Space-strip: lowercase concat of tokens equals slug.
      const slug = 'ackermanngroup';
      expect(tokens.map((t) => t.toLowerCase()).join('')).toBe(slug);
      expect(slug).toHaveLength(14);
    });
  });

  describe('D-11 completely-absent-departments lock', () => {
    it('returns department === null for every listing when wire departments[] is empty', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
      } as ScraperInputDto);

      // Wire fixture has empty departments arrays across all
      // 3 listings — matches the run-387 probe shape (0 of 12
      // listings carry a department).
      for (const listing of JOBS_PAGE_RAW.jobs) {
        expect(listing.departments).toEqual([]);
      }
      for (const job of result.jobs) {
        expect(job.department).toBeNull();
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
        searchTerm: 'leasing',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('ackermanngroup-5165288008');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AckermannGroupService();
      const result = await service.scrape({
        siteType: [Site.ACKERMANNGROUP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
