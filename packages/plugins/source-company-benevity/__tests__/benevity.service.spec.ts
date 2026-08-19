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

import { BenevityModule, BenevityService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'benevity-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 091 / T04 — `BenevityService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BenevityService` through `BenevityModule`.
 *   2. `Site.BENEVITY === 'benevity'` literal pin.
 *   3. Happy path — variant-23 URL pass-through (bare brand-
 *      domain `benevity.com/job-posting?gh_jid=<id>` —
 *      first cohort observation of variant 23).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BenevityService — Spec 091 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BenevityModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BenevityModule],
      }).compile();
      const service = moduleRef.get(BenevityService);
      expect(service).toBeInstanceOf(BenevityService);
      await moduleRef.close();
    });

    it('exports the Site.BENEVITY = "benevity" enum value', () => {
      expect(Site.BENEVITY).toBe('benevity');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const arch = dto.jobs.find((j) => j.id === 'benevity-5817165004');
      expect(arch).toBeDefined();
      expect(arch?.site).toBe(Site.BENEVITY);
      expect(arch?.companyName).toBe('Benevity');
      expect(arch?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(arch?.companyName?.toLowerCase()).toBe('benevity');
      expect(arch?.title).toBe('Architect');
      expect(arch?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // **D-04 lock — variant 23 (bare brand-domain `/job-posting`
      // singular hyphenated)**: emitted `jobUrl` matches wire byte-
      // for-byte; contains `benevity.com/job-posting?gh_jid=`; does
      // NOT contain `job-boards.greenhouse.io` (locks variant-23
      // shape against falling back to variant 2); does NOT contain
      // `/careers/` (locks the no-`/careers/`-prefix sub-axis vs
      // variant 20's `/careers/job-post`).
      expect(arch?.jobUrl).toBe(
        'https://benevity.com/job-posting?gh_jid=5817165004',
      );
      expect(arch?.jobUrl).toContain('benevity.com/job-posting?gh_jid=');
      expect(arch?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(arch?.jobUrl).not.toContain('/careers/');
      expect(arch?.department).toBe('Engineering');
      expect(arch?.location?.city).toBe('Calgary, Alberta, Canada');
      expect(arch?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(arch?.description).not.toContain('&lt;');
      expect(arch?.description).not.toContain('&amp;');
      expect(arch?.description).not.toContain('<p>');
      expect(arch?.description).not.toContain('<strong>');
      expect(arch?.description).toContain('Benevity');

      const ae = dto.jobs.find((j) => j.id === 'benevity-5981406004');
      expect(ae).toBeDefined();
      expect(ae?.title).toBe('Enterprise Account Executive');
      expect(ae?.companyName).toBe('Benevity');
      expect(ae?.location?.city).toBe('Remote, USA');
      expect(ae?.isRemote).toBe(true);
      expect(ae?.department).toBe('Sales');
      expect(ae?.jobUrl).toBe(
        'https://benevity.com/job-posting?gh_jid=5981406004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/benevity/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
        searchTerm: 'EXECUTIVE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('benevity-5981406004');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('benevity-5817165004');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BenevityService();
      const result = await service.scrape({
        siteType: [Site.BENEVITY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
