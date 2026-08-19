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

import { TextioModule, TextioService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'textio-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 174 / T04 — `TextioService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `TextioService` through `TextioModule`.
 *   2. `Site.TEXTIO === 'textio'` literal pin.
 *   3. Happy path — **NEW variant-46 dual-id-query URL byte-
 *      for-byte lock**
 *      (`https://www.textio.com/careers/apply/?job=<id>&gh_jid=<id>`);
 *      **D-09 case-symmetric bare-brand wire pin**
 *      (`'Textio'` 6 bytes; case-symmetric); D-10 clean
 *      title pass-through; D-11 clean dept pass-through.
 *   4. variant-2 fallback when wire omits `absolute_url`.
 *   5..8. resultsWanted cap, searchTerm filters (title +
 *      dept), error handling, empty payload.
 */
describe('TextioService — Spec 174 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through TextioModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TextioModule],
      }).compile();
      const service = moduleRef.get(TextioService);
      expect(service).toBeInstanceOf(TextioService);
      await moduleRef.close();
    });

    it('exports the Site.TEXTIO = "textio" enum value', () => {
      expect(Site.TEXTIO).toBe('textio');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const gmm = dto.jobs.find((j) => j.id === 'textio-7576380003');
      expect(gmm).toBeDefined();
      expect(gmm?.site).toBe(Site.TEXTIO);
      // D-09 case-symmetric bare-brand wire lock.
      expect(gmm?.companyName).toBe('Textio');
      expect(gmm?.companyName?.toLowerCase()).toBe('textio');
      expect(gmm?.companyName).toHaveLength(6);
      // D-10 lock — wire title is clean; emit pass-through.
      expect(gmm?.title).toBe('Growth Marketing Manager');
      // D-04 lock — NEW variant 46 (dual-id query).
      expect(gmm?.jobUrl).toBe(
        'https://www.textio.com/careers/apply/?job=7576380003&gh_jid=7576380003',
      );
      expect(gmm?.jobUrl).toContain('www.textio.com/careers/apply/?job=');
      expect(gmm?.jobUrl).toContain('&gh_jid=');
      // D-11 clean dept pass-through.
      expect(gmm?.department).toBe('Marketing');
      expect(gmm?.location?.city).toBe('San Francisco, CA');
      expect(gmm?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(gmm?.description).not.toContain('&lt;');
      expect(gmm?.description).not.toContain('&amp;');
      expect(gmm?.description).not.toContain('<p>');
      expect(gmm?.description).toContain('Textio');

      const ga = dto.jobs.find((j) => j.id === 'textio-5709105003');
      expect(ga).toBeDefined();
      expect(ga?.title).toBe("Textio's General Application");
      expect(ga?.companyName).toBe('Textio');
      expect(ga?.location?.city).toBe('Remote, US');
      expect(ga?.isRemote).toBe(true);
      expect(ga?.department).toBe('General Application');
      expect(ga?.jobUrl).toBe(
        'https://www.textio.com/careers/apply/?job=5709105003&gh_jid=5709105003',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/textio/jobs?content=true',
      );
    });
  });

  describe('variant-2 fallback', () => {
    it('falls back to canonical Greenhouse host when wire omits absolute_url', async () => {
      const stripped = clone(JOBS_PAGE_RAW);
      delete stripped.jobs[0].absolute_url;

      mockGet.mockResolvedValueOnce({ data: stripped });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
        resultsWanted: 100,
      } as ScraperInputDto);

      const gmm = result.jobs.find((j) => j.id === 'textio-7576380003');
      expect(gmm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/textio/jobs/7576380003',
      );
      expect(gmm?.jobUrl).toContain('job-boards.greenhouse.io/textio/jobs/');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
        searchTerm: 'GROWTH',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('textio-7576380003');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
        searchTerm: 'general application',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('textio-5709105003');
      expect(result.jobs[0].department).toBe('General Application');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new TextioService();
      const result = await service.scrape({
        siteType: [Site.TEXTIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
