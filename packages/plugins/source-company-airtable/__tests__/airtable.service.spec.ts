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

import { AirtableModule, AirtableService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'airtable-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 106 / T04 — `AirtableService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AirtableService` through `AirtableModule`.
 *   2. `Site.AIRTABLE === 'airtable'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 case-
 *      symmetric lock; D-10 trailing-pad title trim; D-11 clean
 *      dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AirtableService — Spec 106 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AirtableModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AirtableModule],
      }).compile();
      const service = moduleRef.get(AirtableService);
      expect(service).toBeInstanceOf(AirtableService);
      await moduleRef.close();
    });

    it('exports the Site.AIRTABLE = "airtable" enum value', () => {
      expect(Site.AIRTABLE).toBe('airtable');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'airtable-8403127002');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.AIRTABLE);
      // D-09 case-symmetric lock.
      expect(ae?.companyName).toBe('Airtable');
      expect(ae?.companyName?.toLowerCase()).toBe('airtable');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive, Strategic Accounts ');
      expect(ae?.title).toBe('Account Executive, Strategic Accounts');
      expect(ae?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/airtable/jobs/8403127002',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/airtable/jobs/');
      expect(ae?.jobUrl).not.toContain('airtable.com');
      expect(ae?.department).toBe('Customer Success & Services');
      expect(ae?.location?.city).toBe('Remote - US');
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).toContain('Airtable');

      const sse = dto.jobs.find((j) => j.id === 'airtable-8409168002');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Platform');
      expect(sse?.companyName).toBe('Airtable');
      expect(sse?.location?.city).toBe('San Francisco, CA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('Engineering');
      expect(sse?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/airtable/jobs/8409168002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/airtable/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
        searchTerm: 'EXECUTIVE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('airtable-8403127002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('airtable-8409168002');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AirtableService();
      const result = await service.scrape({
        siteType: [Site.AIRTABLE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
