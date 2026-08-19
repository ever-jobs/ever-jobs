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

import { LabelboxModule, LabelboxService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'labelbox-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 160 / T04 — `LabelboxService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `LabelboxService` through `LabelboxModule`.
 *   2. `Site.LABELBOX === 'labelbox'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Labelbox'` lock; D-10 clean title pass-
 *      through; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('LabelboxService — Spec 160 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through LabelboxModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [LabelboxModule],
      }).compile();
      const service = moduleRef.get(LabelboxService);
      expect(service).toBeInstanceOf(LabelboxService);
      await moduleRef.close();
    });

    it('exports the Site.LABELBOX = "labelbox" enum value', () => {
      expect(Site.LABELBOX).toBe('labelbox');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'labelbox-4640965007');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.LABELBOX);
      // D-09 case-symmetric lock.
      expect(eng?.companyName).toBe('Labelbox');
      expect(eng?.companyName?.toLowerCase()).toBe('labelbox');
      // D-10 omitted lock — wire title is clean; emitted
      // title byte-for-byte (.trim() is a safe no-op).
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Applied Research Engineer');
      expect(eng?.title).toBe('Applied Research Engineer');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(eng?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/labelbox/jobs/4640965007',
      );
      expect(eng?.jobUrl).toContain('job-boards.greenhouse.io/labelbox/jobs/');
      // D-11 clean dept pass-through.
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('San Francisco, CA');
      expect(eng?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('&amp;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).toContain('Labelbox');

      const fde = dto.jobs.find((j) => j.id === 'labelbox-4640927007');
      expect(fde).toBeDefined();
      expect(fde?.title).toBe('Forward Deployed Engineer');
      expect(fde?.companyName).toBe('Labelbox');
      expect(fde?.location?.city).toBe('Remote, US');
      expect(fde?.isRemote).toBe(true);
      // D-11 clean dept pass-through (multi-token internal-
      // whitespace dept name).
      expect(fde?.department).toBe('Alignerr Services');
      expect(fde?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/labelbox/jobs/4640927007',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/labelbox/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
        searchTerm: 'FORWARD',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('labelbox-4640927007');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
        searchTerm: 'alignerr',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('labelbox-4640927007');
      expect(result.jobs[0].department).toBe('Alignerr Services');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new LabelboxService();
      const result = await service.scrape({
        siteType: [Site.LABELBOX],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
