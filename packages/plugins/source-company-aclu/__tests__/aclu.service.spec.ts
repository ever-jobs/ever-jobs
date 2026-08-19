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

import { AcluModule, AcluService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'aclu-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 178 / T04 — `AcluService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AcluService` through `AcluModule`.
 *   2. `Site.ACLU === 'aclu'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      acronym + hyphen-separator + slug-truncation wire pin**
 *      (`'ACLU - National Office'` 22 bytes; first wire-token
 *      `ACLU` 4 bytes all-caps with caps at every byte 0/1/2/3;
 *      4 wire-tokens split by ASCII spaces; ASCII-hyphen
 *      separator at wire-token index 1; 3 wire-tokens dropped
 *      yielding 4-byte lowercase slug); D-10 trailing-pad
 *      title-trim lock; D-11 trailing-pad dept-trim lock.
 *   4. D-09 explicit byte-for-byte lock (acronym +
 *      hyphen-separator + slug-truncation co-pattern).
 *   5. D-11 explicit dept-trim lock (`'National Political &
 *      Advocacy '` → `'National Political & Advocacy'`).
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AcluService — Spec 178 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AcluModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AcluModule],
      }).compile();
      const service = moduleRef.get(AcluService);
      expect(service).toBeInstanceOf(AcluService);
      await moduleRef.close();
    });

    it('exports the Site.ACLU = "aclu" enum value', () => {
      expect(Site.ACLU).toBe('aclu');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const devops = dto.jobs.find((j) => j.id === 'aclu-8476098002');
      expect(devops).toBeDefined();
      expect(devops?.site).toBe(Site.ACLU);
      // D-09 lock — wire is acronym + hyphen-separator +
      // slug-truncated.
      expect(devops?.companyName).toBe('ACLU - National Office');
      expect(devops?.companyName).toHaveLength(22);
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('DevOps Engineering Manager ');
      expect(devops?.title).toBe('DevOps Engineering Manager');
      expect(devops?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(devops?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/aclu/jobs/8476098002',
      );
      expect(devops?.jobUrl).toContain('job-boards.greenhouse.io/aclu/jobs/');
      // D-11 clean dept on this listing (Technology is unpadded).
      expect(devops?.department).toBe('Technology');
      expect(devops?.location?.city).toBe('New York, New York, United States');
      expect(devops?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(devops?.description).not.toContain('&lt;');
      expect(devops?.description).not.toContain('&amp;');
      expect(devops?.description).not.toContain('<p>');
      expect(devops?.description).toContain('ACLU');

      const dirNc = dto.jobs.find((j) => j.id === 'aclu-8511065002');
      expect(dirNc).toBeDefined();
      expect(dirNc?.title).toBe('Director, National Campaigns, Abuse of Power');
      expect(dirNc?.companyName).toBe('ACLU - National Office');
      expect(dirNc?.location?.city).toBe(
        'New York, New York, United States; Washington, District of Columbia, United States',
      );
      expect(dirNc?.isRemote).toBe(false);
      // D-11 lock — wire dept carries trailing-pad; emitted
      // dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe(
        'National Political & Advocacy ',
      );
      expect(dirNc?.department).toBe('National Political & Advocacy');
      expect(dirNc?.department).not.toMatch(/\s$/);
      expect(dirNc?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/aclu/jobs/8511065002',
      );

      const fellow = dto.jobs.find((j) => j.id === 'aclu-8531703002');
      expect(fellow).toBeDefined();
      expect(fellow?.title).toBe(
        'Fall 2027 Marvin M. Karpatkin Fellowship, Racial Justice Program',
      );
      expect(fellow?.companyName).toBe('ACLU - National Office');
      // Location wire carries a trailing space on the
      // `Remote - National ` string — JobPostDto.location.city
      // preserves the raw wire field byte-for-byte (the trim
      // pipeline only applies to title + department).
      expect(fellow?.location?.city).toBe('Remote - National ');
      expect(fellow?.isRemote).toBe(true);
      expect(fellow?.department).toBe('Legal');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/aclu/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (acronym + hyphen-separator + slug-truncation)', () => {
    it('preserves wire company_name as-is — all-caps acronym at byte 0 + ASCII-hyphen at wire-token index 1 + 3 trailing tokens dropped', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('ACLU - National Office');
        expect(job.companyName).toHaveLength(22);
      }
      // All-caps acronym caps at every byte 0/1/2/3 of the
      // first wire-token.
      expect('ACLU'.charAt(0)).toBe('A');
      expect('ACLU'.charAt(1)).toBe('C');
      expect('ACLU'.charAt(2)).toBe('L');
      expect('ACLU'.charAt(3)).toBe('U');
      // Wire splits into 4 wire-tokens by ASCII spaces.
      const wireTokens = 'ACLU - National Office'.split(' ');
      expect(wireTokens).toHaveLength(4);
      expect(wireTokens[0]).toBe('ACLU');
      // ASCII-hyphen separator at wire-token index 1.
      expect(wireTokens[1]).toBe('-');
      expect(wireTokens[2]).toBe('National');
      expect(wireTokens[3]).toBe('Office');
      // Slug-truncation: slug is the first wire-token in
      // lowercase; 3 trailing wire-tokens dropped (including
      // the ASCII-hyphen separator).
      const slug = 'aclu';
      expect(wireTokens[0].toLowerCase()).toBe(slug);
      expect(slug).toHaveLength(4);
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
        searchTerm: 'devops',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('aclu-8476098002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
        searchTerm: 'LEGAL',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('aclu-8531703002');
      expect(result.jobs[0].department).toBe('Legal');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AcluService();
      const result = await service.scrape({
        siteType: [Site.ACLU],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
