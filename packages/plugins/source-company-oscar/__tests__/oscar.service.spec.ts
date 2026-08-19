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

import { OscarModule, OscarService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'oscar-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 133 / T04 — `OscarService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `OscarService` through `OscarModule`.
 *   2. `Site.OSCAR === 'oscar'` literal pin.
 *   3. Happy path — variant-35 URL byte-for-byte pass-through
 *      (HTTP scheme + `www.hioscar.com/careers/<id>` id-in-
 *      path + gh_jid query — first cohort observation);
 *      **D-09 first-cohort slug-extra-word asymmetric wire**
 *      `'Oscar Health'` lock (slug 5b vs wire 12b);
 *      **D-10 second-cohort leading-pad observation** lock
 *      (` Member & Provider Escalations Team Lead` →
 *      `Member & Provider Escalations Team Lead`); D-11
 *      clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('OscarService — Spec 133 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through OscarModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [OscarModule],
      }).compile();
      const service = moduleRef.get(OscarService);
      expect(service).toBeInstanceOf(OscarService);
      await moduleRef.close();
    });

    it('exports the Site.OSCAR = "oscar" enum value', () => {
      expect(Site.OSCAR).toBe('oscar');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const mpe = dto.jobs.find((j) => j.id === 'oscar-7559119');
      expect(mpe).toBeDefined();
      expect(mpe?.site).toBe(Site.OSCAR);
      // **D-09 first-cohort slug-extra-word asymmetry lock** —
      // wire `'Oscar Health'` 12 bytes (two-token, wire adds
      // entire second word `' Health'` beyond slug); slug
      // `oscar` 5 bytes.
      expect(mpe?.companyName).toBe('Oscar Health');
      expect(mpe?.companyName?.length).toBe(12);
      expect(mpe?.companyName?.toLowerCase()).toBe('oscar health');
      // Slug `oscar` is contained in the wire but the wire
      // has more — first-cohort observation.
      expect(mpe?.companyName?.toLowerCase()).toContain('oscar');
      expect(mpe?.companyName?.toLowerCase()).toContain('health');
      // **D-10 second-cohort LEADING-pad observation** — wire
      // title carries leading-space pad; emitted trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(' Member & Provider Escalations Team Lead');
      expect(mpe?.title).toBe('Member & Provider Escalations Team Lead');
      expect(mpe?.title).not.toMatch(/^\s/);
      // **D-04 lock — variant 35 (first cohort observation of
      // HTTP `www.hioscar.com/careers/<id>?gh_jid=<id>` dual-
      // id form).**
      expect(mpe?.jobUrl).toBe(
        'http://www.hioscar.com/careers/7559119?gh_jid=7559119',
      );
      expect(mpe?.jobUrl).toMatch(/^http:\/\//);
      expect(mpe?.jobUrl).not.toMatch(/^https:\/\//);
      expect(mpe?.jobUrl).toContain('www.hioscar.com/careers/7559119');
      expect(mpe?.jobUrl).toContain('?gh_jid=7559119');
      expect(mpe?.jobUrl).not.toContain('greenhouse.io');
      expect(mpe?.department).toBe('Insurance Operations');
      expect(mpe?.location?.city).toBe('Tempe, AZ');
      expect(mpe?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(mpe?.description).not.toContain('&lt;');
      expect(mpe?.description).not.toContain('&amp;');
      expect(mpe?.description).not.toContain('<p>');
      expect(mpe?.description).not.toContain('<strong>');
      expect(mpe?.description).toContain('Oscar Health');

      const sa = dto.jobs.find((j) => j.id === 'oscar-7682043');
      expect(sa).toBeDefined();
      // D-10 lock — second sample has TRAILING-pad sub-axis.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Senior Analyst, Data Analytics, SIU ');
      expect(sa?.title).toBe('Senior Analyst, Data Analytics, SIU');
      expect(sa?.title).not.toMatch(/\s$/);
      expect(sa?.companyName).toBe('Oscar Health');
      expect(sa?.location?.city).toBe('New York, NY');
      expect(sa?.isRemote).toBe(false);
      expect(sa?.department).toBe('Data');
      expect(sa?.jobUrl).toBe(
        'http://www.hioscar.com/careers/7682043?gh_jid=7682043',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/oscar/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title (matches leading-padded title after trim)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
        searchTerm: 'ESCALATIONS',
      } as ScraperInputDto);

      // The leading-padded wire title matches after trim.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('oscar-7559119');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
        searchTerm: 'insurance',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('oscar-7559119');
      expect(result.jobs[0].department).toBe('Insurance Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new OscarService();
      const result = await service.scrape({
        siteType: [Site.OSCAR],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
