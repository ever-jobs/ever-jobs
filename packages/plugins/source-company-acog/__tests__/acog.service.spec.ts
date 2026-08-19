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

import { AcogModule, AcogService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acog-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 179 / T04 — `AcogService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcogService` through `AcogModule`.
 *   2. `Site.ACOG === 'acog'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      acronym-by-initials wire pin** (`'American College of
 *      Obstetricians and Gynecologists'` 51 bytes; 6 wire-
 *      tokens split by ASCII spaces; 4 PascalCase + 2 all-
 *      lowercase connector; slug `acog` formed by sampling
 *      the first letter of each PascalCase wire-token,
 *      lowercased, with the 2 connectors skipped); D-10
 *      trailing-pad title-trim lock; D-11 clean-pass-through
 *      dept lock.
 *   4. D-09 explicit byte-for-byte lock (acronym-by-initials
 *      slug-derivation with connector-token skip).
 *   5. D-11 explicit clean-pass-through dept lock (every
 *      emitted `department` byte-equals wire
 *      `departments[0].name`).
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcogService — Spec 179 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcogModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcogModule],
      }).compile();
      const service = moduleRef.get(AcogService);
      expect(service).toBeInstanceOf(AcogService);
      await moduleRef.close();
    });

    it('exports the Site.ACOG = "acog" enum value', () => {
      expect(Site.ACOG).toBe('acog');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const dirCgm = dto.jobs.find((j) => j.id === 'acog-4219331009');
      expect(dirCgm).toBeDefined();
      expect(dirCgm?.site).toBe(Site.ACOG);
      // D-09 lock — wire is multi-token PascalCase +
      // lowercase-connector form; slug is acronym-by-
      // initials with connector-skip.
      expect(dirCgm?.companyName).toBe(
        'American College of Obstetricians and Gynecologists',
      );
      expect(dirCgm?.companyName).toHaveLength(51);
      // D-10 lock — wire title carries trailing-pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(
        'Director, Clinical Guidance Methodology ',
      );
      expect(dirCgm?.title).toBe('Director, Clinical Guidance Methodology');
      expect(dirCgm?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(dirCgm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acog/jobs/4219331009',
      );
      expect(dirCgm?.jobUrl).toContain('job-boards.greenhouse.io/acog/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(dirCgm?.department).toBe('Clinical Guidance');
      expect(dirCgm?.location?.city).toBe('Washington, DC');
      expect(dirCgm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(dirCgm?.description).not.toContain('&lt;');
      expect(dirCgm?.description).not.toContain('&amp;');
      expect(dirCgm?.description).not.toContain('<p>');
      expect(dirCgm?.description).toContain('ACOG');

      const hrbp = dto.jobs.find((j) => j.id === 'acog-4108017009');
      expect(hrbp).toBeDefined();
      expect(hrbp?.title).toBe('Human Resources Business Partner');
      expect(hrbp?.companyName).toBe(
        'American College of Obstetricians and Gynecologists',
      );
      expect(hrbp?.department).toBe('Human Resources');
      expect(hrbp?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acog/jobs/4108017009',
      );

      const idesigner = dto.jobs.find((j) => j.id === 'acog-4114509009');
      expect(idesigner).toBeDefined();
      expect(idesigner?.title).toBe('Instructional Designer');
      expect(idesigner?.companyName).toBe(
        'American College of Obstetricians and Gynecologists',
      );
      expect(idesigner?.department).toBe('Publishing and Product Development');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acog/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (acronym-by-initials slug-derivation)', () => {
    it('preserves wire company_name as-is — multi-token PascalCase + 2 lowercase-connector + acronym-by-initials slug', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe(
          'American College of Obstetricians and Gynecologists',
        );
        expect(job.companyName).toHaveLength(51);
      }
      // Wire splits into 6 wire-tokens by ASCII spaces.
      const wireTokens =
        'American College of Obstetricians and Gynecologists'.split(' ');
      expect(wireTokens).toHaveLength(6);
      expect(wireTokens[0]).toBe('American');
      expect(wireTokens[1]).toBe('College');
      expect(wireTokens[2]).toBe('of');
      expect(wireTokens[3]).toBe('Obstetricians');
      expect(wireTokens[4]).toBe('and');
      expect(wireTokens[5]).toBe('Gynecologists');
      // 4 PascalCase tokens (cap at byte 0 only).
      const pascalCaseTokens = wireTokens.filter(
        (t) => t[0] === t[0].toUpperCase() && t.length > 1 && t[1] === t[1].toLowerCase(),
      );
      expect(pascalCaseTokens).toEqual([
        'American',
        'College',
        'Obstetricians',
        'Gynecologists',
      ]);
      expect(pascalCaseTokens).toHaveLength(4);
      // 2 all-lowercase connector tokens.
      const connectorTokens = wireTokens.filter(
        (t) => t === t.toLowerCase(),
      );
      expect(connectorTokens).toEqual(['of', 'and']);
      expect(connectorTokens).toHaveLength(2);
      // Acronym-by-initials slug derivation: sample first
      // letter of each PascalCase wire-token, lowercased,
      // with connectors skipped.
      const slug = pascalCaseTokens
        .map((t) => t[0].toLowerCase())
        .join('');
      expect(slug).toBe('acog');
      expect(slug).toHaveLength(4);
      // Sanity: slug is not a substring of any single wire-
      // token (the acronym-by-initials sub-pattern requires
      // multi-token sampling).
      for (const tok of wireTokens) {
        expect(tok.toLowerCase()).not.toContain(slug);
      }
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
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

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
        searchTerm: 'designer',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acog-4114509009');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
        searchTerm: 'HUMAN RESOURCES',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acog-4108017009');
      expect(result.jobs[0].department).toBe('Human Resources');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcogService();
      const result = await service.scrape({
        siteType: [Site.ACOG],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
