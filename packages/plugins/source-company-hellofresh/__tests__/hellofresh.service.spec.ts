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

import { HelloFreshModule, HelloFreshService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'hellofresh-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 097 / T04 — `HelloFreshService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `HelloFreshService` through `HelloFreshModule`.
 *   2. `Site.HELLOFRESH === 'hellofresh'` literal pin.
 *   3. Happy path — variant-26 URL pass-through (careers-subdomain
 *      + dual-segment locale prefix + path-id + query-id —
 *      first cohort observation of variant 26); D-09 case-
 *      asymmetric PascalCase wire `'HelloFresh'`; D-10 trailing-
 *      pad title trim; D-11 trailing-pad dept trim.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('HelloFreshService — Spec 097 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through HelloFreshModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [HelloFreshModule],
      }).compile();
      const service = moduleRef.get(HelloFreshService);
      expect(service).toBeInstanceOf(HelloFreshService);
      await moduleRef.close();
    });

    it('exports the Site.HELLOFRESH = "hellofresh" enum value', () => {
      expect(Site.HELLOFRESH).toBe('hellofresh');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ap = dto.jobs.find((j) => j.id === 'hellofresh-7775209');
      expect(ap).toBeDefined();
      expect(ap?.site).toBe(Site.HELLOFRESH);
      // **D-09 lock — case-asymmetric PascalCase wire form**:
      // emitted `companyName === 'HelloFresh'` byte-for-byte
      // (10 bytes; same byte-count as the 10-byte slug
      // `hellofresh` but byte-distinct via case at index 5).
      expect(ap?.companyName).toBe('HelloFresh');
      expect(ap?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ap?.companyName).not.toBe(ap?.companyName?.toLowerCase());
      expect(ap?.companyName?.toLowerCase()).toBe('hellofresh');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Asset Protection Specialist ');
      expect(ap?.title).toBe('Asset Protection Specialist');
      expect(ap?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ap?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 26 (careers-subdomain dual-
      // segment-locale-prefix path-id+query-id)**: emitted
      // `jobUrl` byte-for-byte; contains
      // `careers.hellofresh.com/global/en/job/`; contains
      // `?gh_jid=`; does NOT contain `job-boards.greenhouse.io`
      // (locks variant-26 against fallback to variant 2); does
      // NOT contain `www.` (locks the `careers.<brand-domain>`
      // sub-axis vs variant 24's `www.brand.com`); does NOT
      // contain `/all-jobs/` (locks the path-id sub-axis vs
      // variant 21's `/all-jobs/?gh_jid=`).
      expect(ap?.jobUrl).toBe(
        'https://careers.hellofresh.com/global/en/job/7775209?gh_jid=7775209',
      );
      expect(ap?.jobUrl).toContain(
        'careers.hellofresh.com/global/en/job/',
      );
      expect(ap?.jobUrl).toContain('?gh_jid=7775209');
      expect(ap?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ap?.jobUrl).not.toContain('www.');
      expect(ap?.jobUrl).not.toContain('/all-jobs/');
      // D-11 lock — wire dept carries trailing-space pad;
      // emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Operations ');
      expect(ap?.department).toBe('Operations');
      expect(ap?.department).not.toBe(
        JOBS_PAGE_RAW.jobs[0].departments[0].name,
      );
      expect(ap?.department).not.toMatch(/\s$/);
      expect(ap?.location?.city).toBe('UK ');
      expect(ap?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ap?.description).not.toContain('&lt;');
      expect(ap?.description).not.toContain('&amp;');
      expect(ap?.description).not.toContain('<p>');
      expect(ap?.description).not.toContain('<strong>');
      expect(ap?.description).toContain('HelloFresh');

      const cmo = dto.jobs.find((j) => j.id === 'hellofresh-7693012');
      expect(cmo).toBeDefined();
      expect(cmo?.title).toBe('Chief Marketing Officer - DACH');
      expect(cmo?.companyName).toBe('HelloFresh');
      expect(cmo?.location?.city).toBe('Berlin, Germany');
      expect(cmo?.isRemote).toBe(false);
      expect(cmo?.department).toBe('Marketing');
      expect(cmo?.jobUrl).toBe(
        'https://careers.hellofresh.com/global/en/job/7693012?gh_jid=7693012',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/hellofresh/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
        searchTerm: 'CHIEF',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('hellofresh-7693012');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
        searchTerm: 'operations',
      } as ScraperInputDto);

      // D-11 lock — searchTerm hits TRIMMED dept form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('hellofresh-7775209');
      expect(result.jobs[0].department).toBe('Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new HelloFreshService();
      const result = await service.scrape({
        siteType: [Site.HELLOFRESH],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
