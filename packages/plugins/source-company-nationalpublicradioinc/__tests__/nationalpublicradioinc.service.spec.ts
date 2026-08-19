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

import { NPRNationalPublicRadioModule, NPRNationalPublicRadioService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'nationalpublicradioinc-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 889 / T04 — `NPRNationalPublicRadioService` unit tests (≥ 9 cases).
 */
describe('NPRNationalPublicRadioService — Spec 889 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through NPRNationalPublicRadioModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [NPRNationalPublicRadioModule],
      }).compile();
      const service = moduleRef.get(NPRNationalPublicRadioService);
      expect(service).toBeInstanceOf(NPRNationalPublicRadioService);
      await moduleRef.close();
    });

    it('exports the Site.NPR_NATIONAL_PUBLIC_RADIO = "nationalpublicradioinc" enum value', () => {
      expect(Site.NPR_NATIONAL_PUBLIC_RADIO).toBe('nationalpublicradioinc');
    });
  });

  describe('happy path', () => {
    it('maps all fixture listings to JobPostDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === 'nationalpublicradioinc-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.NPR_NATIONAL_PUBLIC_RADIO);
      // D-09 wire company_name pass-through.
      expect(job0?.companyName).toBe('NPR (National Public Radio)');
      // D-10 title-trim lock.
      expect(job0?.title).toBe(String(first.title).trim());
      expect(job0?.title).not.toMatch(/\s$/);
      // D-04 variant-2 URL.
      expect(job0?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/nationalpublicradioinc/jobs/' + first.id,
      );
      expect(job0?.jobUrl).toContain('job-boards.greenhouse.io/nationalpublicradioinc/jobs/');
      // D-11 department-trim lock (null-safe: some boards expose no departments).
      const firstDept =
        first.departments && first.departments[0]
          ? String(first.departments[0].name).trim()
          : null;
      expect(job0?.department).toBe(firstDept);
      expect(job0?.location?.city).toBe(first.location.name);
      expect(job0?.isRemote).toBe(
        String(first.location.name).toLowerCase().includes('remote'),
      );
      // D-08 decode-then-strip regression guard.
      expect(job0?.description).not.toContain('&lt;');
      expect(job0?.description).not.toContain('&amp;');
      expect(job0?.description).not.toContain('<p>');
      expect(job0?.description).toContain('NPR (National Public Radio)');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/nationalpublicradioinc/jobs?content=true',
      );
    });
  });

  describe('company_name pass-through', () => {
    it('emits the wire company_name for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('NPR (National Public Radio)');
      }
    });
  });

  describe('D-10 title-trim lock', () => {
    it('trims wire title padding — no emitted title has surrounding whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
      } as ScraperInputDto);
      // Fixture listing[0] carries trailing-pad on the wire title.
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/\s$/);
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/\s$/);
        expect(job.title).not.toMatch(/^\s/);
      }
    });
  });

  describe('D-11 department-trim lock', () => {
    it('emits trimmed department or null', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
      } as ScraperInputDto);
      for (let i = 0; i < result.jobs.length; i++) {
        const wire = JOBS_PAGE_RAW.jobs[i].departments;
        const expected = wire && wire[0] ? String(wire[0].name).trim() : null;
        expect(result.jobs[i].department).toBe(expected);
        if (result.jobs[i].department) {
          expect(result.jobs[i].department).not.toMatch(/\s$/);
          expect(result.jobs[i].department).not.toMatch(/^\s/);
        }
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).trim().toLowerCase();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        'nationalpublicradioinc-' + JOBS_PAGE_RAW.jobs[0].id,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new NPRNationalPublicRadioService();
      const result = await service.scrape({
        siteType: [Site.NPR_NATIONAL_PUBLIC_RADIO],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
