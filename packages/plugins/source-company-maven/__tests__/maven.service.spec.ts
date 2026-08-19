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

import { MavenModule, MavenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'maven-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 162 / T04 — `MavenService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MavenService` through `MavenModule`.
 *   2. `Site.MAVEN === 'maven'` literal pin (distinct from
 *      Site.MAVENCLINIC = 'mavenclinic').
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Maven'` lock; D-10 clean title pass-
 *      through; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('MavenService — Spec 162 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MavenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MavenModule],
      }).compile();
      const service = moduleRef.get(MavenService);
      expect(service).toBeInstanceOf(MavenService);
      await moduleRef.close();
    });

    it('exports the Site.MAVEN = "maven" enum value distinct from Site.MAVENCLINIC', () => {
      expect(Site.MAVEN).toBe('maven');
      expect(Site.MAVENCLINIC).toBe('mavenclinic');
      expect(Site.MAVEN).not.toBe(Site.MAVENCLINIC);
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const csm = dto.jobs.find((j) => j.id === 'maven-5711779004');
      expect(csm).toBeDefined();
      expect(csm?.site).toBe(Site.MAVEN);
      // D-09 case-symmetric lock.
      expect(csm?.companyName).toBe('Maven');
      expect(csm?.companyName?.toLowerCase()).toBe('maven');
      // D-10 omitted lock — wire title is clean.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Customer Support Manager');
      expect(csm?.title).toBe('Customer Support Manager');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(csm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/maven/jobs/5711779004',
      );
      expect(csm?.jobUrl).toContain('job-boards.greenhouse.io/maven/jobs/');
      // D-11 clean dept pass-through.
      expect(csm?.department).toBe('Operations');
      expect(csm?.location?.city).toBe('San Francisco, CA');
      expect(csm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(csm?.description).not.toContain('&lt;');
      expect(csm?.description).not.toContain('&amp;');
      expect(csm?.description).not.toContain('<p>');
      expect(csm?.description).not.toContain('<strong>');
      expect(csm?.description).toContain('Maven');

      const sse = dto.jobs.find((j) => j.id === 'maven-4023548004');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior/Staff Software Engineer');
      expect(sse?.companyName).toBe('Maven');
      expect(sse?.location?.city).toBe('Remote, US');
      expect(sse?.isRemote).toBe(true);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/maven/jobs/4023548004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/maven/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
        searchTerm: 'SOFTWARE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('maven-4023548004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
        searchTerm: 'operations',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('maven-5711779004');
      expect(result.jobs[0].department).toBe('Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MavenService();
      const result = await service.scrape({
        siteType: [Site.MAVEN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
