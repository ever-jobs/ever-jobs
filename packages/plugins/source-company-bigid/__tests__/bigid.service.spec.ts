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

import { BigIdModule, BigIdService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bigid-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 137 / T04 — `BigIdService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BigIdService` through `BigIdModule`.
 *   2. `Site.BIGID === 'bigid'` literal pin.
 *   3. Happy path — variant-36 URL byte-for-byte pass-through
 *      (first cohort observation of HTTPS bare brand-domain
 *      `/company/careers/job-details/<id>` dual-id form);
 *      D-09 PascalCase THREE-cap case-asymmetric `'BigID'`
 *      lock (caps at 0/3/4 forming embedded 'ID');
 *      D-10 trailing-pad title trim lock; **D-11 applied**
 *      lock with `'Sales Development '` padded → `'Sales
 *      Development'` trimmed.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BigIdService — Spec 137 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BigIdModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BigIdModule],
      }).compile();
      const service = moduleRef.get(BigIdService);
      expect(service).toBeInstanceOf(BigIdService);
      await moduleRef.close();
    });

    it('exports the Site.BIGID = "bigid" enum value', () => {
      expect(Site.BIGID).toBe('bigid');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const pe = dto.jobs.find((j) => j.id === 'bigid-8467296002');
      expect(pe).toBeDefined();
      expect(pe?.site).toBe(Site.BIGID);
      // **D-09 PascalCase THREE-cap case-asymmetric lock —
      // caps at byte indices 0, 3, 4 forming embedded 'ID'**.
      expect(pe?.companyName).toBe('BigID');
      expect(pe?.companyName?.length).toBe(5);
      expect(pe?.companyName?.[0]).toBe('B');
      expect(pe?.companyName?.[3]).toBe('I');
      expect(pe?.companyName?.[4]).toBe('D');
      expect(pe?.companyName?.toLowerCase()).toBe('bigid');
      expect(pe?.companyName).not.toBe('bigid');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Performance Engineer ');
      expect(pe?.title).toBe('Performance Engineer');
      expect(pe?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 36 (first cohort observation of
      // HTTPS bare brand-domain `bigid.com/company/careers/job-
      // details/<id>` dual-id form).**
      expect(pe?.jobUrl).toBe(
        'https://bigid.com/company/careers/job-details/8467296002?gh_jid=8467296002',
      );
      expect(pe?.jobUrl).toMatch(/^https:\/\//);
      expect(pe?.jobUrl).toContain('bigid.com/company/careers/job-details/8467296002');
      expect(pe?.jobUrl).toContain('?gh_jid=8467296002');
      // Bare brand-domain — no www. prefix.
      expect(pe?.jobUrl).not.toContain('www.');
      expect(pe?.jobUrl).not.toContain('greenhouse.io');
      expect(pe?.department).toBe('Engineering');
      expect(pe?.location?.city).toBe('Tel Aviv, Israel');
      expect(pe?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(pe?.description).not.toContain('&lt;');
      expect(pe?.description).not.toContain('&amp;');
      expect(pe?.description).not.toContain('<p>');
      expect(pe?.description).not.toContain('<strong>');
      expect(pe?.description).toContain('BigID');

      const sdr = dto.jobs.find((j) => j.id === 'bigid-8597123005');
      expect(sdr).toBeDefined();
      expect(sdr?.title).toBe('Sales Development Representative');
      expect(sdr?.companyName).toBe('BigID');
      expect(sdr?.location?.city).toBe('New York, NY');
      expect(sdr?.isRemote).toBe(false);
      // **D-11 APPLIED lock** — wire dept carries trailing-
      // space pad; emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Sales Development ');
      expect(sdr?.department).toBe('Sales Development');
      expect(sdr?.department).not.toMatch(/\s$/);
      expect(sdr?.jobUrl).toBe(
        'https://bigid.com/company/careers/job-details/8597123005?gh_jid=8597123005',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bigid/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
        searchTerm: 'PERFORMANCE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bigid-8467296002');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
        searchTerm: 'sales development',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bigid-8597123005');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('Sales Development');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BigIdService();
      const result = await service.scrape({
        siteType: [Site.BIGID],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
