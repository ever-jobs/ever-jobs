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

import { SamsaraModule, SamsaraService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'samsara-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 168 / T04 — `SamsaraService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SamsaraService` through `SamsaraModule`.
 *   2. `Site.SAMSARA === 'samsara'` literal pin.
 *   3. Happy path — **NEW variant-44 vanity-domain URL pass-
 *      through** (first cohort observation; 47th distinct
 *      wire-shape variant); D-09 case-symmetric `'Samsara'`
 *      lock; D-10 NEW same-title both-pad sub-axis title-trim
 *      lock + trailing-only-pad title-trim lock; D-11 clean
 *      dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload, fallback to variant-2 Greenhouse form.
 */
describe('SamsaraService — Spec 168 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SamsaraModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SamsaraModule],
      }).compile();
      const service = moduleRef.get(SamsaraService);
      expect(service).toBeInstanceOf(SamsaraService);
      await moduleRef.close();
    });

    it('exports the Site.SAMSARA = "samsara" enum value', () => {
      expect(Site.SAMSARA).toBe('samsara');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      // ---- Listing 1 — D-10 NEW same-title both-pad lock ----
      const cae = dto.jobs.find((j) => j.id === 'samsara-5747183');
      expect(cae).toBeDefined();
      expect(cae?.site).toBe(Site.SAMSARA);
      // D-09 case-symmetric lock.
      expect(cae?.companyName).toBe('Samsara');
      expect(cae?.companyName?.toLowerCase()).toBe('samsara');
      // D-10 NEW same-title both-pad lock — wire title carries
      // BOTH leading AND trailing ASCII-space pad on the same
      // title; emitted title trimmed symmetrically.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(' Commercial Account Executive ');
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/^\s/);
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/\s$/);
      expect(cae?.title).toBe('Commercial Account Executive');
      expect(cae?.title).not.toMatch(/^\s/);
      expect(cae?.title).not.toMatch(/\s$/);
      // **D-04 NEW variant-44 lock** — first cohort observation
      // of HTTPS + `www.`-prefix + 3-segment
      // /company/careers/roles/<id> path-id leaf + duplicating
      // ?gh_jid=<id> query.
      expect(cae?.jobUrl).toBe(
        'https://www.samsara.com/company/careers/roles/5747183?gh_jid=5747183',
      );
      expect(cae?.jobUrl).toContain('www.samsara.com/company/careers/roles/5747183');
      expect(cae?.jobUrl).toContain('?gh_jid=5747183');
      // D-11 clean dept pass-through.
      expect(cae?.department).toBe('US Commercial AE1');
      expect(cae?.location?.city).toBe('Remote - US');
      expect(cae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(cae?.description).not.toContain('&lt;');
      expect(cae?.description).not.toContain('&amp;');
      expect(cae?.description).not.toContain('<p>');
      expect(cae?.description).not.toContain('<strong>');
      expect(cae?.description).toContain('Samsara');

      // ---- Listing 2 — D-10 trailing-only-pad lock ----
      const sa = dto.jobs.find((j) => j.id === 'samsara-5891234');
      expect(sa).toBeDefined();
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Solutions Architect ');
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/\s$/);
      expect(sa?.title).toBe('Solutions Architect');
      expect(sa?.title).not.toMatch(/\s$/);
      expect(sa?.companyName).toBe('Samsara');
      expect(sa?.location?.city).toBe('Atlanta, GA');
      expect(sa?.isRemote).toBe(false);
      expect(sa?.department).toBe('Sales Engineering');
      expect(sa?.jobUrl).toBe(
        'https://www.samsara.com/company/careers/roles/5891234?gh_jid=5891234',
      );

      // ---- Listing 3 — fully-clean title pass-through ----
      const sse = dto.jobs.find((j) => j.id === 'samsara-5912045');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      expect(sse?.companyName).toBe('Samsara');
      expect(sse?.department).toBe('Platform');
      expect(sse?.location?.city).toBe('San Francisco, CA');
      expect(sse?.isRemote).toBe(false);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/samsara/jobs?content=true',
      );
    });
  });

  describe('jobUrl fallback to variant-2 Greenhouse form', () => {
    it('uses canonical variant-2 jobUrl when wire absolute_url is missing', async () => {
      const noUrlPage = clone(JOBS_PAGE_RAW);
      delete (noUrlPage.jobs[0] as any).absolute_url;
      mockGet.mockResolvedValueOnce({ data: noUrlPage });

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
      } as ScraperInputDto);

      const cae = result.jobs.find((j) => j.id === 'samsara-5747183');
      expect(cae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/samsara/jobs/5747183',
      );
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
        searchTerm: 'ARCHITECT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('samsara-5891234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
        searchTerm: 'platform',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('samsara-5912045');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SamsaraService();
      const result = await service.scrape({
        siteType: [Site.SAMSARA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
