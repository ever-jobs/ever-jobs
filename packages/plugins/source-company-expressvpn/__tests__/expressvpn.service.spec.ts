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

import { ExpressvpnModule, ExpressvpnService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'expressvpn-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 145 / T04 — `ExpressvpnService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ExpressvpnService` through `ExpressvpnModule`.
 *   2. `Site.EXPRESSVPN === 'expressvpn'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      FIRST-COHORT FOUR-cap PascalCase case-asymmetric wire
 *      pin** (`'ExpressVPN'` 10 bytes; caps at 0/7/8/9 forming
 *      embedded `VPN` acronym); **D-10 second-cohort mojibake-
 *      NBSP trailing-pad lock**; D-11 clean dept pass-through.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ExpressvpnService — Spec 145 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ExpressvpnModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ExpressvpnModule],
      }).compile();
      const service = moduleRef.get(ExpressvpnService);
      expect(service).toBeInstanceOf(ExpressvpnService);
      await moduleRef.close();
    });

    it('exports the Site.EXPRESSVPN = "expressvpn" enum value', () => {
      expect(Site.EXPRESSVPN).toBe('expressvpn');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const crm = dto.jobs.find((j) => j.id === 'expressvpn-8524631002');
      expect(crm).toBeDefined();
      expect(crm?.site).toBe(Site.EXPRESSVPN);
      // D-09 FOUR-cap PascalCase case-asymmetric lock.
      expect(crm?.companyName).toBe('ExpressVPN');
      expect(crm?.companyName?.toLowerCase()).toBe('expressvpn');
      // Verify caps positions: 0 (E), 7 (V), 8 (P), 9 (N).
      const cn = crm?.companyName ?? '';
      expect(cn[0]).toBe('E');
      expect(cn[7]).toBe('V');
      expect(cn[8]).toBe('P');
      expect(cn[9]).toBe('N');
      // The trailing 3 chars form the acronym `VPN`.
      expect(cn.slice(7)).toBe('VPN');
      expect(crm?.title).toBe('CRM Marketing Associate - Upsell & Revenue Expansion');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(crm?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/expressvpn/jobs/8524631002',
      );
      expect(crm?.jobUrl).toContain('job-boards.greenhouse.io/expressvpn/jobs/');
      // D-11 clean dept pass-through.
      expect(crm?.department).toBe('Marketing');
      expect(crm?.location?.city).toBe('Remote, US');
      expect(crm?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(crm?.description).not.toContain('&lt;');
      expect(crm?.description).not.toContain('&amp;');
      expect(crm?.description).not.toContain('<p>');
      expect(crm?.description).toContain('ExpressVPN');

      const cs = dto.jobs.find((j) => j.id === 'expressvpn-8524626002');
      expect(cs).toBeDefined();
      // D-10 lock — mojibake-NBSP trailing-pad sub-axis (second
      // cohort observation after Bloomreach Spec 139). `.trim()`
      // strips the trailing NBSP (U+00A0); the residual `Â`
      // (U+00C2) byte remains by-design — wire-faithful.
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/Â $/);
      expect(cs?.title).toBe('Customer Success Data LeadÂ');
      expect(cs?.title).not.toMatch(/ $/);
      expect(cs?.title).toMatch(/Â$/);
      expect(cs?.companyName).toBe('ExpressVPN');
      // D-11 clean dept pass-through (with ampersand).
      expect(cs?.department).toBe('Data Engineering & Insights');
      expect(cs?.location?.city).toBe('London, UK');
      expect(cs?.isRemote).toBe(false);
      expect(cs?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/expressvpn/jobs/8524626002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/expressvpn/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
        searchTerm: 'CRM',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('expressvpn-8524631002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
        searchTerm: 'data engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('expressvpn-8524626002');
      expect(result.jobs[0].department).toBe('Data Engineering & Insights');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ExpressvpnService();
      const result = await service.scrape({
        siteType: [Site.EXPRESSVPN],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
