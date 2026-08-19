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

import { BettermentModule, BettermentService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'betterment-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 120 / T04 — `BettermentService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BettermentService` through `BettermentModule`.
 *   2. `Site.BETTERMENT === 'betterment'` literal pin.
 *   3. Happy path — variant-32 URL pass-through (first cohort
 *      observation of HTTPS `www.<brand>.com/careers/current-
 *      openings/job` duplicate-gh_jid query — second cohort
 *      observation of duplicate-gh_jid form after Elastic);
 *      D-09 case-symmetric `'Betterment'` lock; D-10 trailing-
 *      pad title trim; **D-11 APPLIED — `'Customer Experience '`
 *      padded → `'Customer Experience'` trimmed**.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BettermentService — Spec 120 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BettermentModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BettermentModule],
      }).compile();
      const service = moduleRef.get(BettermentService);
      expect(service).toBeInstanceOf(BettermentService);
      await moduleRef.close();
    });

    it('exports the Site.BETTERMENT = "betterment" enum value', () => {
      expect(Site.BETTERMENT).toBe('betterment');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bdr = dto.jobs.find((j) => j.id === 'betterment-6209414');
      expect(bdr).toBeDefined();
      expect(bdr?.site).toBe(Site.BETTERMENT);
      // D-09 case-symmetric lock.
      expect(bdr?.companyName).toBe('Betterment');
      expect(bdr?.companyName?.toLowerCase()).toBe('betterment');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Business Development Representative ');
      expect(bdr?.title).toBe('Business Development Representative');
      expect(bdr?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 32 (first cohort observation of
      // HTTPS `www.betterment.com/careers/current-openings/job`
      // duplicate-gh_jid query — second cohort observation of
      // dup-gh_jid form after Elastic).**
      expect(bdr?.jobUrl).toBe(
        'https://www.betterment.com/careers/current-openings/job?gh_jid=6209414&gh_jid=6209414',
      );
      expect(bdr?.jobUrl).toMatch(/^https:\/\//);
      expect(bdr?.jobUrl).toContain('www.betterment.com/careers/current-openings/job');
      // Duplicate gh_jid lock.
      expect(bdr?.jobUrl).toMatch(/gh_jid=6209414&gh_jid=6209414/);
      expect((bdr?.jobUrl?.match(/gh_jid=/g) || []).length).toBe(2);
      expect(bdr?.jobUrl).not.toContain('greenhouse.io');
      // **D-11 APPLIED lock** — wire dept carries trailing-
      // space pad; emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Customer Experience ');
      expect(bdr?.department).toBe('Customer Experience');
      expect(bdr?.department).not.toMatch(/\s$/);
      expect(bdr?.location?.city).toBe('New York, NY or Remote, US');
      expect(bdr?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(bdr?.description).not.toContain('&lt;');
      expect(bdr?.description).not.toContain('&amp;');
      expect(bdr?.description).not.toContain('<p>');
      expect(bdr?.description).not.toContain('<strong>');
      expect(bdr?.description).toContain('Betterment');

      const sse = dto.jobs.find((j) => j.id === 'betterment-7851699');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer');
      expect(sse?.companyName).toBe('Betterment');
      expect(sse?.location?.city).toBe('New York, NY');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://www.betterment.com/careers/current-openings/job?gh_jid=7851699&gh_jid=7851699',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/betterment/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
        searchTerm: 'BUSINESS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('betterment-6209414');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
        searchTerm: 'customer experience',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('betterment-6209414');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('Customer Experience');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BettermentService();
      const result = await service.scrape({
        siteType: [Site.BETTERMENT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
