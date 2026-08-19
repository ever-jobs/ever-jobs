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

import { AciLearningModule, AciLearningService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acilearning-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 176 / T04 — `AciLearningService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AciLearningService` through `AciLearningModule`.
 *   2. `Site.ACILEARNING === 'acilearning'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      acronym-prefix + PascalCase-suffix + space-strip wire
 *      pin** (`'ACI Learning'` 12 bytes; first wire token
 *      `ACI` 3 bytes all-caps; second wire token `Learning`
 *      8 bytes PascalCase; space-strip to slug `acilearning`);
 *      D-10 clean title pass-through lock; D-11 clean dept
 *      pass-through lock.
 *   4. D-09 explicit byte-for-byte lock (acronym + PascalCase +
 *      space-strip co-pattern).
 *   5. D-11 clean dept pass-through lock.
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AciLearningService — Spec 176 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AciLearningModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AciLearningModule],
      }).compile();
      const service = moduleRef.get(AciLearningService);
      expect(service).toBeInstanceOf(AciLearningService);
      await moduleRef.close();
    });

    it('exports the Site.ACILEARNING = "acilearning" enum value', () => {
      expect(Site.ACILEARNING).toBe('acilearning');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const aa = dto.jobs.find((j) => j.id === 'acilearning-4243539009');
      expect(aa).toBeDefined();
      expect(aa?.site).toBe(Site.ACILEARNING);
      // D-09 lock — wire is acronym + PascalCase + space-strip.
      expect(aa?.companyName).toBe('ACI Learning');
      expect(aa?.companyName).toHaveLength(12);
      // D-10 lock — wire title carries no padding; emitted
      // title pass-through.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Admissions Advisor (Dallas, TX)');
      expect(aa?.title).toBe('Admissions Advisor (Dallas, TX)');
      expect(aa?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(aa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acilearning/jobs/4243539009',
      );
      expect(aa?.jobUrl).toContain('job-boards.greenhouse.io/acilearning/jobs/');
      // D-11 clean dept on this listing.
      expect(aa?.department).toBe('Tech Academy Admissions');
      expect(aa?.location?.city).toBe('Dallas, TX');
      expect(aa?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(aa?.description).not.toContain('&lt;');
      expect(aa?.description).not.toContain('&amp;');
      expect(aa?.description).not.toContain('<p>');
      expect(aa?.description).toContain('ACI Learning');

      const dr = dto.jobs.find((j) => j.id === 'acilearning-4238021009');
      expect(dr).toBeDefined();
      expect(dr?.title).toBe('Director of Revenue Operations');
      expect(dr?.companyName).toBe('ACI Learning');
      expect(dr?.location?.city).toBe('Remote, US');
      expect(dr?.isRemote).toBe(true);
      expect(dr?.department).toBe('Rev Ops');
      expect(dr?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acilearning/jobs/4238021009',
      );

      const ti = dto.jobs.find((j) => j.id === 'acilearning-4173570009');
      expect(ti).toBeDefined();
      expect(ti?.title).toBe('Technical Instructor I - San Antonio (Part Time)');
      expect(ti?.companyName).toBe('ACI Learning');
      expect(ti?.location?.city).toBe('San Antonio, TX');
      expect(ti?.isRemote).toBe(false);
      expect(ti?.department).toBe('Tech Academy Instructors');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acilearning/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (acronym + PascalCase + space-strip)', () => {
    it('preserves wire company_name as-is — acronym caps at 0/1/2 + PascalCase caps at 0 + 1 space stripped', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('ACI Learning');
        expect(job.companyName).toHaveLength(12);
      }
      // Acronym caps at indices 0, 1, 2 of the first wire token.
      const tokens = 'ACI Learning'.split(' ');
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe('ACI');
      expect(tokens[0].charAt(0)).toBe('A');
      expect(tokens[0].charAt(1)).toBe('C');
      expect(tokens[0].charAt(2)).toBe('I');
      // PascalCase cap at index 0 of the second wire token.
      expect(tokens[1]).toBe('Learning');
      expect(tokens[1].charAt(0)).toBe('L');
      // Space-strip: lowercase concat of tokens equals slug.
      const slug = 'acilearning';
      expect(tokens.map((t) => t.toLowerCase()).join('')).toBe(slug);
      expect(slug).toHaveLength(11);
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
        searchTerm: 'instructor',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acilearning-4173570009');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
        searchTerm: 'REV OPS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acilearning-4238021009');
      expect(result.jobs[0].department).toBe('Rev Ops');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AciLearningService();
      const result = await service.scrape({
        siteType: [Site.ACILEARNING],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
