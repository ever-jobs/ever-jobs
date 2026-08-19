import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture
// rather than the live Greenhouse public API.
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

import { GitlabModule, GitlabService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'gitlab-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 033 / T04 — `GitlabService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `GitlabService` through `GitlabModule`.
 *   2. `Site.GITLAB === 'gitlab'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `gitlab` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('GitlabService — Spec 033 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through GitlabModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GitlabModule],
      }).compile();
      const service = moduleRef.get(GitlabService);
      expect(service).toBeInstanceOf(GitlabService);
      await moduleRef.close();
    });

    it('exports the Site.GITLAB = "gitlab" enum value', () => {
      expect(Site.GITLAB).toBe('gitlab');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GitlabService();
      const input: ScraperInputDto = {
        siteType: [Site.GITLAB],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const runner = dto.jobs.find((j) => j.id === 'gitlab-9201234');
      expect(runner).toBeDefined();
      expect(runner?.site).toBe(Site.GITLAB);
      expect(runner?.companyName).toBe('Gitlab');
      expect(runner?.title).toBe('Staff Backend Engineer, GitLab Runner Cloud');
      expect(runner?.jobUrl).toBe(
        'https://boards.greenhouse.io/gitlab/jobs/9201234',
      );
      expect(runner?.location?.city).toBe('San Francisco, CA');
      expect(runner?.department).toBe('Engineering');
      expect(runner?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(runner?.description).not.toContain('<p>');
      expect(runner?.description).toContain('GitLab Runner Cloud');

      const success = dto.jobs.find((j) => j.id === 'gitlab-9202345');
      expect(success?.isRemote).toBe(true);
      expect(success?.department).toBe('Customer Success');

      // Regression guard: the slug must be `gitlab` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/gitlab/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GitlabService();
      const input: ScraperInputDto = {
        siteType: [Site.GITLAB],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GitlabService();
      const result = await service.scrape({
        siteType: [Site.GITLAB],
        searchTerm: 'RUNNER CLOUD',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gitlab-9201234');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GitlabService();
      const result = await service.scrape({
        siteType: [Site.GITLAB],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('gitlab-9202345');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new GitlabService();
      const result = await service.scrape({
        siteType: [Site.GITLAB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new GitlabService();
      const result = await service.scrape({
        siteType: [Site.GITLAB],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
