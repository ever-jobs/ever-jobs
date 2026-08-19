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

import { AssemblyAIModule, AssemblyAIService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'assemblyai-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 108 / T04 — `AssemblyAIService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AssemblyAIService` through `AssemblyAIModule`.
 *   2. `Site.ASSEMBLYAI === 'assemblyai'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 PascalCase
 *      THREE-cap (indices 0/8/9) case-asymmetric wire `'AssemblyAI'`
 *      (first cohort observation); D-10 trailing-pad title trim;
 *      D-11 trailing-pad dept trim (highest pad rate ~43% in
 *      cohort).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AssemblyAIService — Spec 108 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AssemblyAIModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AssemblyAIModule],
      }).compile();
      const service = moduleRef.get(AssemblyAIService);
      expect(service).toBeInstanceOf(AssemblyAIService);
      await moduleRef.close();
    });

    it('exports the Site.ASSEMBLYAI = "assemblyai" enum value', () => {
      expect(Site.ASSEMBLYAI).toBe('assemblyai');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const fde = dto.jobs.find((j) => j.id === 'assemblyai-4691426005');
      expect(fde).toBeDefined();
      expect(fde?.site).toBe(Site.ASSEMBLYAI);
      // **D-09 lock — FIRST-COHORT PascalCase THREE-cap (indices
      // 0/8/9) same-byte-count case-asymmetric wire form**:
      // emitted `companyName === 'AssemblyAI'` byte-for-byte
      // (10 bytes); same byte-count as slug `assemblyai`.
      expect(fde?.companyName).toBe('AssemblyAI');
      expect(fde?.companyName?.length).toBe(10);
      expect(fde?.companyName?.toLowerCase()).toBe('assemblyai');
      expect(fde?.companyName?.charCodeAt(0)).toBe(65); // 'A'
      expect(fde?.companyName?.charCodeAt(8)).toBe(65); // 'A'
      expect(fde?.companyName?.charCodeAt(9)).toBe(73); // 'I'
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Forward Deployed Engineer ');
      expect(fde?.title).toBe('Forward Deployed Engineer');
      expect(fde?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(fde?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(fde?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/assemblyai/jobs/4691426005',
      );
      expect(fde?.jobUrl).toContain('job-boards.greenhouse.io/assemblyai/jobs/');
      expect(fde?.jobUrl).not.toContain('assemblyai.com');
      // D-11 lock — wire dept carries trailing-space pad;
      // emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Customer Experience ');
      expect(fde?.department).toBe('Customer Experience');
      expect(fde?.department).not.toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(fde?.department).not.toMatch(/\s$/);
      expect(fde?.location?.city).toContain('Remote');
      expect(fde?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(fde?.description).not.toContain('&lt;');
      expect(fde?.description).not.toContain('&amp;');
      expect(fde?.description).not.toContain('<p>');
      expect(fde?.description).not.toContain('<strong>');
      expect(fde?.description).toContain('AssemblyAI');

      const srs = dto.jobs.find((j) => j.id === 'assemblyai-4688321005');
      expect(srs).toBeDefined();
      expect(srs?.title).toBe('Senior Research Scientist');
      expect(srs?.companyName).toBe('AssemblyAI');
      // D-11 lock — second listing also has trailing-pad dept;
      // emitted dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Research ');
      expect(srs?.department).toBe('Research');
      expect(srs?.department).not.toMatch(/\s$/);
      expect(srs?.location?.city).toBe('San Francisco, CA');
      expect(srs?.isRemote).toBe(false);
      expect(srs?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/assemblyai/jobs/4688321005',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/assemblyai/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
        searchTerm: 'SCIENTIST',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('assemblyai-4688321005');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
        searchTerm: 'customer experience',
      } as ScraperInputDto);

      // D-11 lock — searchTerm hits TRIMMED dept form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('assemblyai-4691426005');
      expect(result.jobs[0].department).toBe('Customer Experience');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AssemblyAIService();
      const result = await service.scrape({
        siteType: [Site.ASSEMBLYAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
