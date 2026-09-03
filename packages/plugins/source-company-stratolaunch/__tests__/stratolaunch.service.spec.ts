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

import { StratolaunchModule, StratolaunchService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'stratolaunch-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 5089 / T04 — `StratolaunchService` unit tests.
 */
describe('StratolaunchService — Spec 5089 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through StratolaunchModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [StratolaunchModule],
      }).compile();
      const service = moduleRef.get(StratolaunchService);
      expect(service).toBeInstanceOf(StratolaunchService);
      await moduleRef.close();
    });

    it('exports Site.STRATOLAUNCH = "stratolaunch"', () => {
      expect(Site.STRATOLAUNCH).toBe('stratolaunch');
    });
  });

  describe('happy path', () => {
    it('maps all fixture listings to JobPostDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(JOBS_PAGE_RAW.jobs.length);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === 'stratolaunch-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.STRATOLAUNCH);
      expect(job0?.companyName).toBe('Stratolaunch');
      expect(job0?.title).toBe(String(first.title).trim());
      expect(job0?.title).not.toMatch(/\s$/);
      expect(job0?.jobUrl).toBe(first.absolute_url);
      expect(job0?.applyUrl).toBe(first.absolute_url);
      expect(job0?.jobUrl).toContain('job-boards.greenhouse.io/stratolaunch/jobs/');
      expect(job0?.location?.city).toBe(first.location.name);
      expect(job0?.datePosted).toBe(first.first_published);
      expect(job0?.department).toBe(
        first.departments && first.departments[0]
          ? String(first.departments[0].name).trim()
          : null,
      );
      // D-03: entity-decode-then-strip regression guard.
      expect(job0?.description).not.toContain('&lt;');
      expect(job0?.description).not.toContain('&amp;');
      expect(job0?.description).not.toContain('<p>');
      expect(job0?.description).toContain('Stratolaunch');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/stratolaunch/jobs?content=true',
      );
    });
  });

  describe('company_name pass-through', () => {
    it('emits the wire company_name for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('Stratolaunch');
      }
    });
  });

  describe('D-05 title and department trim', () => {
    it('trims wire title and department padding', async () => {
      const fixture = clone(JOBS_PAGE_RAW);
      fixture.jobs[0].title = '  ' + fixture.jobs[0].title + '  ';
      fixture.jobs[0].departments[0].name =
        '  ' + fixture.jobs[0].departments[0].name + '  ';
      mockGet.mockResolvedValueOnce({ data: fixture });

      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);
      const job0 = result.jobs[0];
      expect(job0.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(job0.title).not.toMatch(/^\s/);
      expect(job0.title).not.toMatch(/\s$/);
      expect(job0.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(job0.department).not.toMatch(/^\s/);
      expect(job0.department).not.toMatch(/\s$/);
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 55-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).trim().toLowerCase();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        'stratolaunch-' + JOBS_PAGE_RAW.jobs[0].id,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('location filter', () => {
    it('filters by case-insensitive location substring', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        location: 'Mojave',
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThan(0);
      for (const job of result.jobs) {
        expect(job.location?.city?.toLowerCase()).toContain('mojave');
      }
    });

    it('returns empty for a non-matching location', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        location: 'Antarctica',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('isRemote detection', () => {
    it('marks remote jobs from Work Location metadata', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
        resultsWanted: 100,
      } as ScraperInputDto);
      const remote = result.jobs.filter((j) => j.isRemote);
      expect(remote.length).toBeGreaterThan(0);
      for (const job of remote) {
        const raw = JOBS_PAGE_RAW.jobs.find(
          (r: any) => r.id.toString() === String(job.id).replace('stratolaunch-', ''),
        );
        const hasRemoteMeta = (raw?.metadata ?? []).some(
          (m: any) =>
            m?.name === 'Work Location' &&
            (m?.value ?? []).some((v: string) => v?.toLowerCase() === 'remote'),
        );
        expect(hasRemoteMeta).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
