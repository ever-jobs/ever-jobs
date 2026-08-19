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

import { BillcomModule, BillcomService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'billcom-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 092 / T04 — `BillcomService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BillcomService` through `BillcomModule`.
 *   2. `Site.BILLCOM === 'billcom'` literal pin.
 *   3. Happy path — variant-24 URL pass-through (www-prefixed
 *      slug-divergent vanity `www.bill.com/job?<id>&gh_jid=<id>` —
 *      first cohort observation of variant 24); D-10 applied
 *      (mixed pad: trailing-space + leading-tab); D-11 applied
 *      (trailing-space pad on dept).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BillcomService — Spec 092 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BillcomModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BillcomModule],
      }).compile();
      const service = moduleRef.get(BillcomService);
      expect(service).toBeInstanceOf(BillcomService);
      await moduleRef.close();
    });

    it('exports the Site.BILLCOM = "billcom" enum value', () => {
      expect(Site.BILLCOM).toBe('billcom');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ds = dto.jobs.find((j) => j.id === 'billcom-5970283004');
      expect(ds).toBeDefined();
      expect(ds?.site).toBe(Site.BILLCOM);
      expect(ds?.companyName).toBe('BILL');
      expect(ds?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // D-09 case-asymmetric all-caps lock.
      expect(ds?.companyName).not.toBe(ds?.companyName?.toLowerCase());
      // D-10 lock — wire title carries trailing-space pad; emitted
      // title trimmed (no trailing whitespace) and matches the
      // hand-trimmed form.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe(
        'Associate Fraud Strategy Data Scientist ',
      );
      expect(ds?.title).toBe('Associate Fraud Strategy Data Scientist');
      expect(ds?.title).not.toBe(JOBS_PAGE_RAW.jobs[0].title);
      expect(ds?.title).not.toMatch(/\s$/);
      // **D-04 lock — variant 24 (www-prefixed slug-divergent
      // vanity `bill.com` root-level `/job` dual-id query)**:
      // emitted `jobUrl` matches wire byte-for-byte; contains
      // `www.bill.com/job?`; contains the dual-id `&gh_jid=`
      // payload; does NOT contain `job-boards.greenhouse.io`
      // (locks variant-24 shape against falling back to variant
      // 2); does NOT contain `/careers/` (locks the root-level
      // path sub-axis vs variant 20's `/careers/job-post`); does
      // NOT contain `/job-posting` (locks the singular `/job` no-
      // hyphen sub-axis vs variant 23's `/job-posting`
      // hyphenated).
      expect(ds?.jobUrl).toBe(
        'https://www.bill.com/job?5970283004&gh_jid=5970283004',
      );
      expect(ds?.jobUrl).toContain('www.bill.com/job?');
      expect(ds?.jobUrl).toContain('&gh_jid=5970283004');
      expect(ds?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ds?.jobUrl).not.toContain('/careers/');
      expect(ds?.jobUrl).not.toContain('/job-posting');
      // D-11 lock — wire dept carries trailing-space pad; emitted
      // dept trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('Engineering ');
      expect(ds?.department).toBe('Engineering');
      expect(ds?.department).not.toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ds?.department).not.toMatch(/\s$/);
      expect(ds?.location?.city).toBe('Draper, Utah, United States');
      expect(ds?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ds?.description).not.toContain('&lt;');
      expect(ds?.description).not.toContain('&amp;');
      expect(ds?.description).not.toContain('<p>');
      expect(ds?.description).not.toContain('<strong>');
      expect(ds?.description).toContain('BILL');

      const pm = dto.jobs.find((j) => j.id === 'billcom-5848551004');
      expect(pm).toBeDefined();
      // D-10 lock — leading-TAB pad form (first cohort
      // observation of `\t` tab-character pad-byte): wire title
      // begins with `\t`; emitted title has the tab stripped.
      expect(JOBS_PAGE_RAW.jobs[1].title.charCodeAt(0)).toBe(9); // 0x09 == \t
      expect(pm?.title).toBe(
        'Senior Product Manager - Developer Ecosystem & Partner Platform',
      );
      expect(pm?.title?.charCodeAt(0)).not.toBe(9);
      expect(pm?.title).not.toMatch(/^\s/);
      expect(pm?.companyName).toBe('BILL');
      expect(pm?.location?.city).toBe('Remote, USA');
      expect(pm?.isRemote).toBe(true);
      // Second listing dept is byte-clean (`'Product'` — no pad)
      // so trimmed form === wire form.
      expect(pm?.department).toBe('Product');
      expect(pm?.jobUrl).toBe(
        'https://www.bill.com/job?5848551004&gh_jid=5848551004',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/billcom/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
        searchTerm: 'PRODUCT MANAGER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('billcom-5848551004');
    });

    it('filters by case-insensitive substring of trimmed department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // D-11 lock — searchTerm hits the TRIMMED dept form even
      // though wire pad-bytes would still match a substring; the
      // emitted dept is the clean trimmed form.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('billcom-5970283004');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BillcomService();
      const result = await service.scrape({
        siteType: [Site.BILLCOM],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
