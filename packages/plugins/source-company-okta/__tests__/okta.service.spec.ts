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

import { OktaModule, OktaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'okta-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 115 / T04 — `OktaService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `OktaService` through `OktaModule`.
 *   2. `Site.OKTA === 'okta'` literal pin.
 *   3. Happy path — variant-31 URL pass-through (first cohort
 *      observation of HTTPS `/company/careers/opportunity/<id>`
 *      id-in-path + gh_jid query); D-09 case-symmetric lock;
 *      D-10 trailing-pad title trim; D-11 first-cohort suffix-
 *      numeric-ID dept naming pass-through (`<name>-<numeric ID>`).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('OktaService — Spec 115 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through OktaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [OktaModule],
      }).compile();
      const service = moduleRef.get(OktaService);
      expect(service).toBeInstanceOf(OktaService);
      await moduleRef.close();
    });

    it('exports the Site.OKTA = "okta" enum value', () => {
      expect(Site.OKTA).toBe('okta');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const aiops = dto.jobs.find((j) => j.id === 'okta-7439531');
      expect(aiops).toBeDefined();
      expect(aiops?.site).toBe(Site.OKTA);
      // D-09 case-symmetric lock.
      expect(aiops?.companyName).toBe('Okta');
      expect(aiops?.companyName?.toLowerCase()).toBe('okta');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AI Operations Lead ');
      expect(aiops?.title).toBe('AI Operations Lead');
      expect(aiops?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 31 (first cohort observation of
      // HTTPS `www.okta.com/company/careers/opportunity/<id>`
      // id-in-path + gh_jid query).**
      expect(aiops?.jobUrl).toBe(
        'https://www.okta.com/company/careers/opportunity/7439531?gh_jid=7439531',
      );
      expect(aiops?.jobUrl).toMatch(/^https:\/\//);
      expect(aiops?.jobUrl).toContain('www.okta.com/company/careers/opportunity/7439531');
      expect(aiops?.jobUrl).toContain('?gh_jid=7439531');
      expect(aiops?.jobUrl).not.toContain('greenhouse.io');
      // **D-11 lock — first-cohort suffix-numeric-ID dept
      // naming convention (`<name>-<numeric ID>`)**: emitted
      // department `'Auth0 DevRel-494'` byte-for-byte.
      expect(aiops?.department).toBe('Auth0 DevRel-494');
      expect(aiops?.department).toMatch(/-\d+$/);
      expect(aiops?.location?.city).toBe('San Francisco, CA');
      expect(aiops?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(aiops?.description).not.toContain('&lt;');
      expect(aiops?.description).not.toContain('&amp;');
      expect(aiops?.description).not.toContain('<p>');
      expect(aiops?.description).not.toContain('<strong>');
      expect(aiops?.description).toContain('Okta');

      const sse = dto.jobs.find((j) => j.id === 'okta-7782413');
      expect(sse).toBeDefined();
      expect(sse?.title).toBe('Senior Software Engineer, Workforce Identity');
      expect(sse?.companyName).toBe('Okta');
      expect(sse?.location?.city).toBe('Bellevue, WA');
      expect(sse?.isRemote).toBe(false);
      expect(sse?.department).toBe('BT Engineering Services-779');
      expect(sse?.department).toMatch(/-\d+$/);
      expect(sse?.jobUrl).toBe(
        'https://www.okta.com/company/careers/opportunity/7782413?gh_jid=7782413',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/okta/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
        searchTerm: 'WORKFORCE',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('okta-7782413');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
        searchTerm: 'auth0',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('okta-7439531');
      expect(result.jobs[0].department).toBe('Auth0 DevRel-494');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new OktaService();
      const result = await service.scrape({
        siteType: [Site.OKTA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
