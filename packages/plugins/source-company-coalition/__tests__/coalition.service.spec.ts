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

import { CoalitionModule, CoalitionService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'coalition-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 095 / T04 — `CoalitionService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `CoalitionService` through `CoalitionModule`.
 *   2. `Site.COALITION === 'coalition'` literal pin.
 *   3. Happy path — variant-25 URL pass-through (www-prefixed
 *      slug-divergent vanity `www.coalitioninc.com/job-posting`
 *      — first cohort observation of variant 25); D-09 legal-
 *      entity comma-suffix wire `'Coalition, Inc.'` byte-for-
 *      byte (first cohort observation); D-10 leading-double-
 *      space pad trim (first cohort observation); D-11 clean
 *      pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('CoalitionService — Spec 095 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CoalitionModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CoalitionModule],
      }).compile();
      const service = moduleRef.get(CoalitionService);
      expect(service).toBeInstanceOf(CoalitionService);
      await moduleRef.close();
    });

    it('exports the Site.COALITION = "coalition" enum value', () => {
      expect(Site.COALITION).toBe('coalition');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ir = dto.jobs.find((j) => j.id === 'coalition-4665762005');
      expect(ir).toBeDefined();
      expect(ir?.site).toBe(Site.COALITION);
      // **D-09 lock — first-cohort legal-entity comma-suffix
      // wire form**: emitted `companyName === 'Coalition, Inc.'`
      // byte-for-byte (15 bytes). The wire is byte-distinct from
      // the bare brand `'Coalition'` (9 bytes — the slug form).
      expect(ir?.companyName).toBe('Coalition, Inc.');
      expect(ir?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ir?.companyName).toContain(', Inc.');
      expect(ir?.companyName).not.toBe('Coalition');
      // D-10 lock — leading-DOUBLE-space pad form (first cohort
      // observation of leading-multi-byte-ASCII-space pad-byte
      // run under D-10): wire title begins with two leading
      // ASCII spaces; emitted title has both stripped.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(
        '  Senior Incident Response Analyst',
      );
      expect(JOBS_PAGE_RAW.jobs[0].title.charCodeAt(0)).toBe(32); // ASCII space
      expect(JOBS_PAGE_RAW.jobs[0].title.charCodeAt(1)).toBe(32); // ASCII space
      expect(ir?.title).toBe('Senior Incident Response Analyst');
      expect(ir?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ir?.title).not.toMatch(/^\s/);
      // **D-04 lock — variant 25 (www-prefixed slug-divergent
      // vanity `coalitioninc.com` root-level `/job-posting`
      // single-id query)**: emitted `jobUrl` byte-for-byte;
      // contains `www.coalitioninc.com/job-posting?gh_jid=`;
      // does NOT contain `job-boards.greenhouse.io` (locks
      // variant-25 against fallback to variant 2); does NOT
      // contain `/careers/` (locks the root-level path sub-axis
      // vs variant 20's `/careers/job-post`); does NOT contain
      // `/job?` (locks the `/job-posting` hyphenated form vs
      // variant 24's bare `/job`).
      expect(ir?.jobUrl).toBe(
        'https://www.coalitioninc.com/job-posting?gh_jid=4665762005',
      );
      expect(ir?.jobUrl).toContain(
        'www.coalitioninc.com/job-posting?gh_jid=',
      );
      expect(ir?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ir?.jobUrl).not.toContain('/careers/');
      expect(ir?.jobUrl).not.toContain('/job?');
      expect(ir?.department).toBe('Incident Response (CIR)');
      expect(ir?.location?.city).toBe('Any location, United States');
      expect(ir?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ir?.description).not.toContain('&lt;');
      expect(ir?.description).not.toContain('&amp;');
      expect(ir?.description).not.toContain('<p>');
      expect(ir?.description).not.toContain('<strong>');
      expect(ir?.description).toContain('Coalition');

      const as = dto.jobs.find((j) => j.id === 'coalition-4686184005');
      expect(as).toBeDefined();
      expect(as?.title).toBe('Applied Scientist II');
      expect(as?.companyName).toBe('Coalition, Inc.');
      expect(as?.location?.city).toBe('Remote, United States');
      expect(as?.isRemote).toBe(true);
      expect(as?.department).toBe('Data');
      expect(as?.jobUrl).toBe(
        'https://www.coalitioninc.com/job-posting?gh_jid=4686184005',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/coalition/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
        searchTerm: 'INCIDENT',
      } as ScraperInputDto);

      // D-10 lock — searchTerm hits the TRIMMED title form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coalition-4665762005');
      expect(result.jobs[0].title).toBe('Senior Incident Response Analyst');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
        searchTerm: 'data',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('coalition-4686184005');
      expect(result.jobs[0].department).toBe('Data');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new CoalitionService();
      const result = await service.scrape({
        siteType: [Site.COALITION],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
