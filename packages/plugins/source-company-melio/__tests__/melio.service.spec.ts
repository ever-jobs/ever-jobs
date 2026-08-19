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

import { MelioModule, MelioService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'melio-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 130 / T04 — `MelioService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MelioService` through `MelioModule`.
 *   2. `Site.MELIO === 'melio'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric `'Melio'` lock; D-10 trailing-pad title trim
 *      lock; **D-11 APPLIED lock** with `'Design '` padded →
 *      `'Design'` trimmed.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('MelioService — Spec 130 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MelioModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MelioModule],
      }).compile();
      const service = moduleRef.get(MelioService);
      expect(service).toBeInstanceOf(MelioService);
      await moduleRef.close();
    });

    it('exports the Site.MELIO = "melio" enum value', () => {
      expect(Site.MELIO).toBe('melio');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const dfa = dto.jobs.find((j) => j.id === 'melio-7692118003');
      expect(dfa).toBeDefined();
      expect(dfa?.site).toBe(Site.MELIO);
      // D-09 case-symmetric lock.
      expect(dfa?.companyName).toBe('Melio');
      expect(dfa?.companyName?.toLowerCase()).toBe('melio');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Director of FP&A ');
      expect(dfa?.title).toBe('Director of FP&A');
      expect(dfa?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(dfa?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/melio/jobs/7692118003',
      );
      expect(dfa?.jobUrl).toContain('job-boards.greenhouse.io/melio/jobs/');
      expect(dfa?.department).toBe('Finance');
      expect(dfa?.location?.city).toBe('New York, NY');
      expect(dfa?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(dfa?.description).not.toContain('&lt;');
      expect(dfa?.description).not.toContain('&amp;');
      expect(dfa?.description).not.toContain('<p>');
      expect(dfa?.description).not.toContain('<strong>');
      expect(dfa?.description).toContain('Melio');

      const spd = dto.jobs.find((j) => j.id === 'melio-7783950002');
      expect(spd).toBeDefined();
      expect(spd?.title).toBe('Senior Product Designer');
      expect(spd?.companyName).toBe('Melio');
      expect(spd?.location?.city).toBe('Tel Aviv, Israel');
      expect(spd?.isRemote).toBe(false);
      // **D-11 APPLIED lock** — wire dept carries trailing-
      // space pad; emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Design ');
      expect(spd?.department).toBe('Design');
      expect(spd?.department).not.toMatch(/\s$/);
      expect(spd?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/melio/jobs/7783950002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/melio/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
        searchTerm: 'DESIGNER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('melio-7783950002');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
        searchTerm: 'design',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('melio-7783950002');
      // The trimmed dept name participates in the match.
      expect(result.jobs[0].department).toBe('Design');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MelioService();
      const result = await service.scrape({
        siteType: [Site.MELIO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
