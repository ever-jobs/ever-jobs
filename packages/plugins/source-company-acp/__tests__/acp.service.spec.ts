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

import { AcpModule, AcpService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'acp-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 181 / T04 — `AcpService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcpService` through `AcpModule`.
 *   2. `Site.ACP === 'acp'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      acronym-by-initials wire pin** (`'Academy with
 *      Community Partners'` 31 bytes; 4 wire-tokens; 3
 *      PascalCase + 1 lowercase-connector; slug `acp` formed
 *      by sampling first letter of each PascalCase wire-
 *      token, lowercased, with the 1 connector skipped);
 *      D-10 clean-pass-through title lock; D-11 clean-pass-
 *      through dept lock.
 *   4. D-09 explicit byte-for-byte lock (acronym-by-
 *      initials slug-derivation with connector-skip; second
 *      cohort observation).
 *   5. D-11 explicit clean-pass-through dept lock (every
 *      emitted `department` byte-equals wire
 *      `departments[0].name`).
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcpService — Spec 181 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcpModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcpModule],
      }).compile();
      const service = moduleRef.get(AcpService);
      expect(service).toBeInstanceOf(AcpService);
      await moduleRef.close();
    });

    it('exports the Site.ACP = "acp" enum value', () => {
      expect(Site.ACP).toBe('acp');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const science = dto.jobs.find((j) => j.id === 'acp-7719489003');
      expect(science).toBeDefined();
      expect(science?.site).toBe(Site.ACP);
      // D-09 lock — wire is multi-token PascalCase +
      // lowercase-connector form; slug is acronym-by-
      // initials with connector-skip (second observation).
      expect(science?.companyName).toBe('Academy with Community Partners');
      expect(science?.companyName).toHaveLength(31);
      // D-10 lock — wire title flows through byte-for-byte
      // (no `.trim()` overlay).
      expect(science?.title).toBe('9-12th Grade Science Teacher');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(science?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acp/jobs/7719489003',
      );
      expect(science?.jobUrl).toContain('job-boards.greenhouse.io/acp/jobs/');
      // D-11 clean — dept flows through byte-for-byte.
      expect(science?.department).toBe('High School Teaching');
      expect(science?.location?.city).toBe('Academy with Community Partners');
      expect(science?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(science?.description).not.toContain('&lt;');
      expect(science?.description).not.toContain('&amp;');
      expect(science?.description).not.toContain('<p>');
      expect(science?.description).toContain('Academy with Community Partners');

      const sped = dto.jobs.find((j) => j.id === 'acp-7722835003');
      expect(sped).toBeDefined();
      expect(sped?.title).toBe('Special Education Teacher');
      expect(sped?.companyName).toBe('Academy with Community Partners');
      expect(sped?.department).toBe('Special Education');
      expect(sped?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/acp/jobs/7722835003',
      );

      const spedPt = dto.jobs.find((j) => j.id === 'acp-7722840003');
      expect(spedPt).toBeDefined();
      expect(spedPt?.title).toBe('Special Education Teacher (Part-time)');
      expect(spedPt?.companyName).toBe('Academy with Community Partners');
      expect(spedPt?.department).toBe('Special Education');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/acp/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (acronym-by-initials slug-derivation; second cohort observation)', () => {
    it('preserves wire company_name as-is — multi-token PascalCase + 1 lowercase-connector + acronym-by-initials slug', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Academy with Community Partners');
        expect(job.companyName).toHaveLength(31);
      }
      // Wire splits into 4 wire-tokens by ASCII spaces.
      const wireTokens =
        'Academy with Community Partners'.split(' ');
      expect(wireTokens).toHaveLength(4);
      expect(wireTokens[0]).toBe('Academy');
      expect(wireTokens[1]).toBe('with');
      expect(wireTokens[2]).toBe('Community');
      expect(wireTokens[3]).toBe('Partners');
      // 3 PascalCase tokens (cap at byte 0 only).
      const pascalCaseTokens = wireTokens.filter(
        (t) => t[0] === t[0].toUpperCase() && t.length > 1 && t[1] === t[1].toLowerCase(),
      );
      expect(pascalCaseTokens).toEqual([
        'Academy',
        'Community',
        'Partners',
      ]);
      expect(pascalCaseTokens).toHaveLength(3);
      // 1 all-lowercase connector token.
      const connectorTokens = wireTokens.filter(
        (t) => t === t.toLowerCase(),
      );
      expect(connectorTokens).toEqual(['with']);
      expect(connectorTokens).toHaveLength(1);
      // Acronym-by-initials slug derivation: sample first
      // letter of each PascalCase wire-token, lowercased,
      // with connector skipped.
      const slug = pascalCaseTokens
        .map((t) => t[0].toLowerCase())
        .join('');
      expect(slug).toBe('acp');
      expect(slug).toHaveLength(3);
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

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
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

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
        searchTerm: 'science',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('acp-7719489003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
        searchTerm: 'SPECIAL EDUCATION',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs.map((j) => j.id).sort()).toEqual([
        'acp-7722835003',
        'acp-7722840003',
      ]);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcpService();
      const result = await service.scrape({
        siteType: [Site.ACP],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
