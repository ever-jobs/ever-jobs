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

import { SquarespaceModule, SquarespaceService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'squarespace-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 088 / T04 — `SquarespaceService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `SquarespaceService` through `SquarespaceModule`.
 *   2. `Site.SQUARESPACE === 'squarespace'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-22 URL pass-
 *      through INCLUDING the **HTTP scheme** (first cohort
 *      observation — every prior cohort variant uses HTTPS),
 *      decode-then-strip pipeline cleanliness, case-symmetric
 *      wire `companyName === 'Squarespace'`, D-10 application
 *      lock, D-11 omission lock.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department (case-insensitive).
 *   7. HTTP 500 → `{ jobs: [] }`.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('SquarespaceService — Spec 088 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through SquarespaceModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SquarespaceModule],
      }).compile();
      const service = moduleRef.get(SquarespaceService);
      expect(service).toBeInstanceOf(SquarespaceService);
      await moduleRef.close();
    });

    it('exports the Site.SQUARESPACE = "squarespace" enum value', () => {
      expect(Site.SQUARESPACE).toBe('squarespace');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const eng = dto.jobs.find((j) => j.id === 'squarespace-7557125');
      expect(eng).toBeDefined();
      expect(eng?.site).toBe(Site.SQUARESPACE);
      // D-09 omission lock: case-symmetric wire `'Squarespace'`.
      expect(eng?.companyName).toBe('Squarespace');
      expect(eng?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(eng?.companyName?.toLowerCase()).toBe('squarespace');
      // First-listing title clean — D-10 trim no-op.
      expect(eng?.title).toBe('Backend Engineer, Domains Registrar');
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // **D-04 lock — variant-22 with FIRST cohort observation
      // of HTTP scheme**: emitted `jobUrl` starts with `http://`
      // (NOT `https://`) AND contains `www.squarespace.com/about/careers?gh_jid=`
      // byte-for-byte. The HTTP scheme is preserved through the
      // pass-through with no upgrade — the plugin honours wire
      // fidelity. Twenty-fifth distinct wire-shape variant in the
      // company-direct cohort.
      expect(eng?.jobUrl).toBe(
        'http://www.squarespace.com/about/careers?gh_jid=7557125',
      );
      expect(eng?.jobUrl?.startsWith('http://')).toBe(true);
      expect(eng?.jobUrl?.startsWith('https://')).toBe(false);
      expect(eng?.jobUrl).toContain('www.squarespace.com/about/careers?gh_jid=');
      expect(eng?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // First-listing dept clean — D-11 omitted.
      expect(eng?.department).toBe('Engineering (Domains & Apps)');
      expect(eng?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(eng?.location?.city).toBe('Dublin, Ireland');
      expect(eng?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(eng?.description).not.toContain('&lt;');
      expect(eng?.description).not.toContain('&amp;');
      expect(eng?.description).not.toContain('&#8217;');
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).not.toContain('<strong>');
      expect(eng?.description).toContain('Squarespace');
      expect(eng?.description).toContain('Domains Registrar');

      const community = dto.jobs.find((j) => j.id === 'squarespace-7744285');
      expect(community).toBeDefined();
      // D-10 application lock — single-trailing-pad form: emitted
      // `title` for the second listing equals trimmed form
      // `'Connections & Community Lead'` (no trailing pad bytes)
      // AND byte-distinct from wire form `'Connections & Community
      // Lead '` AND exactly 1 byte shorter. Twenty-fourth cohort
      // plugin to apply D-10.
      expect(community?.title).toBe('Connections & Community Lead');
      expect(community?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Connections & Community Lead ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(community?.title.endsWith(' ')).toBe(false);
      expect(community?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(community?.companyName).toBe('Squarespace');
      expect(community?.location?.city).toBe('New York, NY');
      expect(community?.isRemote).toBe(false);
      expect(community?.department).toBe('People');
      // Variant-22 lock for second listing — HTTP scheme.
      expect(community?.jobUrl).toBe(
        'http://www.squarespace.com/about/careers?gh_jid=7744285',
      );
      expect(community?.jobUrl?.startsWith('http://')).toBe(true);
      expect(community?.jobUrl?.startsWith('https://')).toBe(false);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/squarespace/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
        searchTerm: 'COMMUNITY',
      } as ScraperInputDto);

      // 'Community' only in second listing.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('squarespace-7744285');
      expect(result.jobs[0].title).toBe('Connections & Community Lead');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // 'Engineering' only in first listing's dept ('Engineering
      // (Domains & Apps)'). The second listing's dept is 'People'
      // and title is 'Connections & Community Lead' — neither
      // contains 'engineering'.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('squarespace-7557125');
      expect(result.jobs[0].department).toBe('Engineering (Domains & Apps)');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new SquarespaceService();
      const result = await service.scrape({
        siteType: [Site.SQUARESPACE],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
