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

import { NetskopeModule, NetskopeService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'netskope-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 163 / T04 — `NetskopeService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `NetskopeService` through `NetskopeModule`.
 *   2. `Site.NETSKOPE === 'netskope'` literal pin.
 *   3. Happy path — **NEW variant-43 vanity-domain URL pass-
 *      through** (first cohort observation; 46th distinct
 *      wire-shape variant); D-09 case-symmetric `'Netskope'`
 *      lock; D-10 trailing-pad title-trim lock; D-11 clean
 *      dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload, fallback to variant-2 Greenhouse form.
 */
describe('NetskopeService — Spec 163 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through NetskopeModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [NetskopeModule],
      }).compile();
      const service = moduleRef.get(NetskopeService);
      expect(service).toBeInstanceOf(NetskopeService);
      await moduleRef.close();
    });

    it('exports the Site.NETSKOPE = "netskope" enum value', () => {
      expect(Site.NETSKOPE).toBe('netskope');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csm = dto.jobs.find((j) => j.id === 'netskope-7495945');
      expect(csm).toBeDefined();
      expect(csm?.site).toBe(Site.NETSKOPE);
      // D-09 case-symmetric lock.
      expect(csm?.companyName).toBe('Netskope');
      expect(csm?.companyName?.toLowerCase()).toBe('netskope');
      // D-10 trailing-pad lock — wire title carries trailing-
      // space pad; emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Channel Sales Manager ');
      expect(csm?.title).toBe('Channel Sales Manager');
      expect(csm?.title).not.toMatch(/\s$/);
      // **D-04 NEW variant-43 lock** — first cohort observation
      // of HTTPS + `www.`-prefix + 3-segment
      // /company/careers/open-positions/ path with trailing
      // slash + query-only-id.
      expect(csm?.jobUrl).toBe(
        'https://www.netskope.com/company/careers/open-positions/?gh_jid=7495945',
      );
      expect(csm?.jobUrl).toContain('www.netskope.com/company/careers/open-positions/');
      expect(csm?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(csm?.department).toBe('Channel Sales');
      expect(csm?.location?.city).toBe('Austin, TX');
      expect(csm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(csm?.description).not.toContain('&lt;');
      expect(csm?.description).not.toContain('&amp;');
      expect(csm?.description).not.toContain('<p>');
      expect(csm?.description).not.toContain('<strong>');
      expect(csm?.description).toContain('Netskope');

      const aice = dto.jobs.find((j) => j.id === 'netskope-7646769');
      expect(aice).toBeDefined();
      expect(aice?.title).toBe('AI Consulting Solutions Engineer');
      expect(aice?.companyName).toBe('Netskope');
      expect(aice?.location?.city).toBe('Remote, US');
      expect(aice?.isRemote).toBe(true);
      expect(aice?.department).toBe('Sales Engineering');
      expect(aice?.jobUrl).toBe(
        'https://www.netskope.com/company/careers/open-positions/?gh_jid=7646769',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/netskope/jobs?content=true',
      );
    });
  });

  describe('jobUrl fallback to variant-2 Greenhouse form', () => {
    it('uses canonical variant-2 jobUrl when wire absolute_url is missing', async () => {
      const noUrlPage = clone(JOBS_PAGE_RAW);
      delete (noUrlPage.jobs[0] as any).absolute_url;
      mockGet.mockResolvedValueOnce({ data: noUrlPage });

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
      } as ScraperInputDto);

      const csm = result.jobs.find((j) => j.id === 'netskope-7495945');
      expect(csm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/netskope/jobs/7495945',
      );
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
        searchTerm: 'CONSULTING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('netskope-7646769');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
        searchTerm: 'channel',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('netskope-7495945');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new NetskopeService();
      const result = await service.scrape({
        siteType: [Site.NETSKOPE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
