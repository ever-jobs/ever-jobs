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

import { FormlabsModule, FormlabsService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'formlabs-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 147 / T04 — `FormlabsService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `FormlabsService` through `FormlabsModule`.
 *   2. `Site.FORMLABS === 'formlabs'` literal pin.
 *   3. Happy path — **variant-40 URL byte-for-byte lock**
 *      (`careers.formlabs.com/job/<id>/apply/?gh_jid=<id>`
 *      careers-subdomain action-leaf form); D-09 case-
 *      symmetric `'Formlabs'` lock; **D-10 first-cohort
 *      triple-trailing-space pad lock**; D-11 clean dept
 *      pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('FormlabsService — Spec 147 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through FormlabsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FormlabsModule],
      }).compile();
      const service = moduleRef.get(FormlabsService);
      expect(service).toBeInstanceOf(FormlabsService);
      await moduleRef.close();
    });

    it('exports the Site.FORMLABS = "formlabs" enum value', () => {
      expect(Site.FORMLABS).toBe('formlabs');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const sh = dto.jobs.find((j) => j.id === 'formlabs-7859917');
      expect(sh).toBeDefined();
      expect(sh?.site).toBe(Site.FORMLABS);
      // D-09 case-symmetric lock.
      expect(sh?.companyName).toBe('Formlabs');
      expect(sh?.companyName?.toLowerCase()).toBe('formlabs');
      expect(sh?.title).toBe('2nd Shift Production Specialist');
      // D-04 lock — variant 40 (careers-subdomain action-leaf
      // dual-id form).
      expect(sh?.jobUrl).toBe(
        'https://careers.formlabs.com/job/7859917/apply/?gh_jid=7859917',
      );
      expect(sh?.jobUrl).toContain('careers.formlabs.com/job/');
      expect(sh?.jobUrl).toContain('/apply/');
      expect(sh?.jobUrl).toContain('?gh_jid=');
      // D-11 clean dept pass-through.
      expect(sh?.department).toBe('Manufacturing');
      expect(sh?.location?.city).toBe('Somerville, MA');
      expect(sh?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(sh?.description).not.toContain('&lt;');
      expect(sh?.description).not.toContain('&amp;');
      expect(sh?.description).not.toContain('<p>');
      expect(sh?.description).toContain('Formlabs');

      const rs = dto.jobs.find((j) => j.id === 'formlabs-7649250');
      expect(rs).toBeDefined();
      // D-10 lock — wire title carries TRIPLE-trailing-space
      // pad (first cohort observation; distinct from Justworks
      // double-pad).
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Robotic Systems Integration Engineer (SLA & SLS)   ',
      );
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/ {3}$/);
      expect(rs?.title).toBe('Robotic Systems Integration Engineer (SLA & SLS)');
      expect(rs?.title).not.toMatch(/\s$/);
      expect(rs?.companyName).toBe('Formlabs');
      expect(rs?.location?.city).toBe('Remote, US');
      expect(rs?.isRemote).toBe(true);
      expect(rs?.department).toBe('Hardware Engineering');
      expect(rs?.jobUrl).toBe(
        'https://careers.formlabs.com/job/7649250/apply/?gh_jid=7649250',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/formlabs/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
        searchTerm: 'ROBOTIC',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('formlabs-7649250');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
        searchTerm: 'manufacturing',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('formlabs-7859917');
      expect(result.jobs[0].department).toBe('Manufacturing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new FormlabsService();
      const result = await service.scrape({
        siteType: [Site.FORMLABS],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
