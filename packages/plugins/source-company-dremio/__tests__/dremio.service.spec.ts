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

import { DremioModule, DremioService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'dremio-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 128 / T04 — `DremioService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DremioService` through `DremioModule`.
 *   2. `Site.DREMIO === 'dremio'` literal pin.
 *   3. Happy path — variant-33 URL pass-through (first cohort
 *      observation of HTTPS `www.dremio.com/careers/job-
 *      postings/?gh_jid=` query-only id); D-09 case-symmetric
 *      lock; D-10 trailing-pad title trim; D-11 first-cohort
 *      sentence-style catchall dept observation pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('DremioService — Spec 128 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DremioModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DremioModule],
      }).compile();
      const service = moduleRef.get(DremioService);
      expect(service).toBeInstanceOf(DremioService);
      await moduleRef.close();
    });

    it('exports the Site.DREMIO = "dremio" enum value', () => {
      expect(Site.DREMIO).toBe('dremio');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const spm = dto.jobs.find((j) => j.id === 'dremio-7578193003');
      expect(spm).toBeDefined();
      expect(spm?.site).toBe(Site.DREMIO);
      // D-09 case-symmetric lock.
      expect(spm?.companyName).toBe('Dremio');
      expect(spm?.companyName?.toLowerCase()).toBe('dremio');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Senior Product Manager ');
      expect(spm?.title).toBe('Senior Product Manager');
      expect(spm?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 33 (first cohort observation of
      // HTTPS `www.dremio.com/careers/job-postings/?gh_jid=`
      // query-only id).**
      expect(spm?.jobUrl).toBe(
        'https://www.dremio.com/careers/job-postings/?gh_jid=7578193003',
      );
      expect(spm?.jobUrl).toMatch(/^https:\/\//);
      expect(spm?.jobUrl).toContain('www.dremio.com/careers/job-postings/');
      expect(spm?.jobUrl).toContain('?gh_jid=7578193003');
      expect(spm?.jobUrl).not.toContain('greenhouse.io');
      expect(spm?.department).toBe('Product');
      expect(spm?.location?.city).toBe('Mountain View, CA');
      expect(spm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(spm?.description).not.toContain('&lt;');
      expect(spm?.description).not.toContain('&amp;');
      expect(spm?.description).not.toContain('<p>');
      expect(spm?.description).not.toContain('<strong>');
      expect(spm?.description).toContain('Dremio');

      const fo = dto.jobs.find((j) => j.id === 'dremio-7689201006');
      expect(fo).toBeDefined();
      expect(fo?.title).toBe('Future Opportunities');
      expect(fo?.companyName).toBe('Dremio');
      expect(fo?.location?.city).toBe('Remote, US');
      expect(fo?.isRemote).toBe(true);
      // **D-11 lock — first-cohort sentence-style catchall
      // dept name pass-through preserved byte-for-byte
      // (including question mark and exclamation point).**
      expect(fo?.department).toBe(
        'Unsure what to apply for? No worries! Submit your resume here.',
      );
      expect(fo?.department).toMatch(/\?/);
      expect(fo?.department).toMatch(/!/);
      expect(fo?.jobUrl).toBe(
        'https://www.dremio.com/careers/job-postings/?gh_jid=7689201006',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/dremio/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
        searchTerm: 'PRODUCT MANAGER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dremio-7578193003');
    });

    it('filters by case-insensitive substring of department name (incl. sentence-style catchall)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
        searchTerm: 'unsure',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dremio-7689201006');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DremioService();
      const result = await service.scrape({
        siteType: [Site.DREMIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
