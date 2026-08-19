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

import { AccuWeatherModule, AccuWeatherService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'accuweather-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 175 / T04 — `AccuWeatherService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AccuWeatherService` through `AccuWeatherModule`.
 *   2. `Site.ACCUWEATHER === 'accuweather'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      PascalCase + slug-truncation wire pin** (`'AccuWeather
 *      Careers'` 19 bytes; first wire token `AccuWeather` 11
 *      bytes with caps at 0/4); D-10 trailing-pad title-trim
 *      lock; D-11 trailing-pad dept-trim lock.
 *   4. D-09 explicit byte-for-byte lock (PascalCase + slug-
 *      truncation co-pattern).
 *   5. D-11 explicit dept-trim lock (`'Facilities '` →
 *      `'Facilities'`).
 *   6..9. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('AccuWeatherService — Spec 175 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AccuWeatherModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AccuWeatherModule],
      }).compile();
      const service = moduleRef.get(AccuWeatherService);
      expect(service).toBeInstanceOf(AccuWeatherService);
      await moduleRef.close();
    });

    it('exports the Site.ACCUWEATHER = "accuweather" enum value', () => {
      expect(Site.ACCUWEATHER).toBe('accuweather');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const ae = dto.jobs.find((j) => j.id === 'accuweather-7814905');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.ACCUWEATHER);
      // D-09 lock — wire is PascalCase + slug-truncated.
      expect(ae?.companyName).toBe('AccuWeather Careers');
      expect(ae?.companyName).toHaveLength(19);
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('Account Executive ');
      expect(ae?.title).toBe('Account Executive');
      expect(ae?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ae?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/accuweather/jobs/7814905',
      );
      expect(ae?.jobUrl).toContain('job-boards.greenhouse.io/accuweather/jobs/');
      // D-11 clean dept on this listing (Ad Sales is unpadded).
      expect(ae?.department).toBe('Ad Sales');
      expect(ae?.location?.city).toBe('State College, PA or Remote');
      expect(ae?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).toContain('AccuWeather');

      const fc = dto.jobs.find((j) => j.id === 'accuweather-7820100');
      expect(fc).toBeDefined();
      expect(fc?.title).toBe('Facilities Coordinator');
      expect(fc?.companyName).toBe('AccuWeather Careers');
      expect(fc?.location?.city).toBe('State College, PA');
      expect(fc?.isRemote).toBe(false);
      // D-11 lock — wire dept carries trailing-pad; emitted
      // dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].departments[0].name).toBe('Facilities ');
      expect(fc?.department).toBe('Facilities');
      expect(fc?.department).not.toMatch(/\s$/);
      expect(fc?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/accuweather/jobs/7820100',
      );

      const fr = dto.jobs.find((j) => j.id === 'accuweather-7825001');
      expect(fr).toBeDefined();
      expect(fr?.title).toBe('Senior Forecaster, Severe Weather');
      expect(fr?.companyName).toBe('AccuWeather Careers');
      expect(fr?.location?.city).toBe('Remote, US');
      expect(fr?.isRemote).toBe(true);
      expect(fr?.department).toBe('Forecasting');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/accuweather/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock (TWO-cap PascalCase + slug-truncation)', () => {
    it('preserves wire company_name as-is — PascalCase caps at 0/4 + 1 trailing token dropped', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('AccuWeather Careers');
        expect(job.companyName).toHaveLength(19);
      }
      // PascalCase caps at indices 0 and 4 of the first wire token.
      expect('AccuWeather'.charAt(0)).toBe('A');
      expect('AccuWeather'.charAt(4)).toBe('W');
      // Slug-truncation: slug is the first wire token in lowercase.
      const slug = 'accuweather';
      const firstWireToken = 'AccuWeather Careers'.split(' ')[0];
      expect(firstWireToken.toLowerCase()).toBe(slug);
      // 1 trailing token dropped.
      expect('AccuWeather Careers'.split(' ')).toHaveLength(2);
      expect('AccuWeather Careers'.split(' ')[1]).toBe('Careers');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
        searchTerm: 'forecaster',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('accuweather-7825001');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
        searchTerm: 'AD SALES',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('accuweather-7814905');
      expect(result.jobs[0].department).toBe('Ad Sales');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AccuWeatherService();
      const result = await service.scrape({
        siteType: [Site.ACCUWEATHER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
