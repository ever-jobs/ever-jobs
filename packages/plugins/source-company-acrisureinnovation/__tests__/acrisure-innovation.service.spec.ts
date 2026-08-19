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

import { AcrisureInnovationModule, AcrisureInnovationService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acrisureinnovation-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 183 / T04 — `AcrisureInnovationService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcrisureInnovationService` through `AcrisureInnovationModule`.
 *   2. `Site.ACRISUREINNOVATION === 'acrisureinnovation'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric two-token PascalCase + space-strip wire pin
 *      (`'Acrisure Innovation'` 19 bytes); D-10 leading-only +
 *      leading-AND-trailing-pad applied lock; D-11 clean-
 *      pass-through dept lock.
 *   4. D-09 byte-for-byte lock (case-symmetric two-token
 *      PascalCase + space-strip — 2 caps at indices 0 & 9 in
 *      wire / no caps in slug).
 *   5. D-10 leading-AND-trailing-pad applied lock.
 *   6. D-11 clean-pass-through dept lock.
 *   7..10. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcrisureInnovationService — Spec 183 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcrisureInnovationModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcrisureInnovationModule],
      }).compile();
      const service = moduleRef.get(AcrisureInnovationService);
      expect(service).toBeInstanceOf(AcrisureInnovationService);
      await moduleRef.close();
    });

    it('exports the Site.ACRISUREINNOVATION = "acrisureinnovation" enum value', () => {
      expect(Site.ACRISUREINNOVATION).toBe('acrisureinnovation');
    });
  });

  describe('happy path — 4 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(4);

      const da = dto.jobs.find((j) => j.id === 'acrisureinnovation-8558844002');
      expect(da).toBeDefined();
      expect(da?.site).toBe(Site.ACRISUREINNOVATION);
      // D-09 lock — case-symmetric two-token PascalCase + space-strip.
      expect(da?.companyName).toBe('Acrisure Innovation');
      expect(da?.companyName).toHaveLength(19);
      // D-10 lock — clean title flows through unchanged.
      expect(da?.title).toBe('Data Analyst, Customer Success');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(da?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acrisureinnovation/jobs/8558844002',
      );
      expect(da?.jobUrl).toContain('job-boards.greenhouse.io/acrisureinnovation/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(da?.department).toBe('Data');
      expect(da?.location?.city).toBe('Atlanta, GA');
      expect(da?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(da?.description).not.toContain('&lt;');
      expect(da?.description).not.toContain('&amp;');
      expect(da?.description).not.toContain('<p>');
      expect(da?.description).toContain('Acrisure Innovation');

      // D-10 leading-only-pad lock — wire title ' Forward Deployed (Echo)- Atlanta, GA'
      // (1 leading ASCII space; no trailing) → trimmed to
      // 'Forward Deployed (Echo)- Atlanta, GA'.
      const fdAtl = dto.jobs.find((j) => j.id === 'acrisureinnovation-8464583002');
      expect(fdAtl).toBeDefined();
      expect(fdAtl?.title).toBe('Forward Deployed (Echo)- Atlanta, GA');
      expect(fdAtl?.title.startsWith(' ')).toBe(false);
      expect(fdAtl?.title.endsWith(' ')).toBe(false);
      expect(fdAtl?.department).toBe('Engineering');

      // D-10 leading-AND-trailing-pad lock — wire title
      // ' Forward Deployed (Echo) - Austin, TX ' (1 leading
      // ASCII space + 1 trailing ASCII space) → trimmed to
      // 'Forward Deployed (Echo) - Austin, TX'. **First cohort
      // observation of the leading-AND-trailing pad sub-form.**
      const fdAus = dto.jobs.find((j) => j.id === 'acrisureinnovation-8461186002');
      expect(fdAus).toBeDefined();
      expect(fdAus?.title).toBe('Forward Deployed (Echo) - Austin, TX');
      expect(fdAus?.title.startsWith(' ')).toBe(false);
      expect(fdAus?.title.endsWith(' ')).toBe(false);

      const pmm = dto.jobs.find((j) => j.id === 'acrisureinnovation-8461205002');
      expect(pmm).toBeDefined();
      expect(pmm?.title).toBe('Senior Product Marketing Manager');
      expect(pmm?.companyName).toBe('Acrisure Innovation');
      expect(pmm?.department).toBe('Marketing');
      expect(pmm?.isRemote).toBe(true);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acrisureinnovation/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (case-symmetric two-token PascalCase + space-strip)', () => {
    it('preserves wire company_name as-is — 2 PascalCase tokens, slug is space-strip lowercase', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Acrisure Innovation');
        expect(job.companyName).toHaveLength(19);
      }
      const wire = 'Acrisure Innovation';
      // Two tokens separated by a single ASCII space.
      const tokens = wire.split(' ');
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe('Acrisure');
      expect(tokens[1]).toBe('Innovation');
      // Caps at byte 0 (of first token) and byte 9 (start of
      // second token after the internal space).
      expect(wire[0]).toBe('A');
      expect(wire[9]).toBe('I');
      const capIndices: number[] = [];
      for (let i = 0; i < wire.length; i++) {
        if (wire[i] >= 'A' && wire[i] <= 'Z') capIndices.push(i);
      }
      expect(capIndices).toEqual([0, 9]);
      // Slug = lowercase + space-strip.
      expect(wire.toLowerCase().replace(/ /g, '')).toBe('acrisureinnovation');
    });
  });

  describe('D-10 leading-AND-trailing pad applied lock', () => {
    it('strips both leading and trailing ASCII-space padding via .trim()', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
      } as ScraperInputDto);

      // Two padded fixture titles: one leading-only, one
      // leading-AND-trailing.
      const leadingOnlyWire = ' Forward Deployed (Echo)- Atlanta, GA';
      const leadingAndTrailingWire = ' Forward Deployed (Echo) - Austin, TX ';
      expect(leadingOnlyWire.startsWith(' ')).toBe(true);
      expect(leadingOnlyWire.endsWith(' ')).toBe(false);
      expect(leadingAndTrailingWire.startsWith(' ')).toBe(true);
      expect(leadingAndTrailingWire.endsWith(' ')).toBe(true);

      for (const job of result.jobs) {
        expect(job.title.startsWith(' ')).toBe(false);
        expect(job.title.endsWith(' ')).toBe(false);
      }

      const fdAtl = result.jobs.find((j) => j.id === 'acrisureinnovation-8464583002');
      const fdAus = result.jobs.find((j) => j.id === 'acrisureinnovation-8461186002');
      expect(fdAtl?.title).toBe(leadingOnlyWire.trim());
      expect(fdAus?.title).toBe(leadingAndTrailingWire.trim());
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
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
    it('honours resultsWanted=2 against a 4-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
        resultsWanted: 2,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
        searchTerm: 'analyst',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acrisureinnovation-8558844002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
        searchTerm: 'MARKETING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acrisureinnovation-8461205002');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcrisureInnovationService();
      const result = await service.scrape({
        siteType: [Site.ACRISUREINNOVATION],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
