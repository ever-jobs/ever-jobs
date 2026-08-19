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

import { DropboxModule, DropboxService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'dropbox-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 040 / T04 — `DropboxService` unit tests.
 *
 * Coverage (≥ 6 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `DropboxService` through `DropboxModule`.
 *   2. `Site.DROPBOX === 'dropbox'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including a regression assertion that the fetched URL uses the
 *      bare `dropbox` Greenhouse slug.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('DropboxService — Spec 040 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through DropboxModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DropboxModule],
      }).compile();
      const service = moduleRef.get(DropboxService);
      expect(service).toBeInstanceOf(DropboxService);
      await moduleRef.close();
    });

    it('exports the Site.DROPBOX = "dropbox" enum value', () => {
      expect(Site.DROPBOX).toBe('dropbox');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DropboxService();
      const input: ScraperInputDto = {
        siteType: [Site.DROPBOX],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'dropbox-7646405');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.DROPBOX);
      expect(eng?.companyName).toBe('Dropbox');
      expect(eng?.title).toBe(
        'Senior Software Engineer, Dash Search Indexing',
      );
      expect(eng?.jobUrl).toBe(
        'https://jobs.dropbox.com/listing/7646405?gh_jid=7646405',
      );
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.department).toBe('Engineering');
      expect(eng?.isRemote).toBe(false);
      // The HTML stripper removes tags but preserves text content.
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('universal-search indexing pipeline');

      const cs = dto.jobs.find((j) => j.id === 'dropbox-7646422');
      expect(cs?.isRemote).toBe(true);
      expect(cs?.department).toBe('Customer Success');

      // Regression guard: the slug must be `dropbox` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/dropbox/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DropboxService();
      const input: ScraperInputDto = {
        siteType: [Site.DROPBOX],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DropboxService();
      const result = await service.scrape({
        siteType: [Site.DROPBOX],
        searchTerm: 'SEARCH INDEXING',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dropbox-7646405');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new DropboxService();
      const result = await service.scrape({
        siteType: [Site.DROPBOX],
        searchTerm: 'customer success',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('dropbox-7646422');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new DropboxService();
      const result = await service.scrape({
        siteType: [Site.DROPBOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new DropboxService();
      const result = await service.scrape({
        siteType: [Site.DROPBOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
