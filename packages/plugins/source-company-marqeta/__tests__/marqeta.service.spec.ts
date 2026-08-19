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

import { MarqetaModule, MarqetaService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'marqeta-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 084 / T04 — `MarqetaService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `MarqetaService` through `MarqetaModule`.
 *   2. `Site.MARQETA === 'marqeta'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s.
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department (case-insensitive).
 *   7. HTTP 500 → `{ jobs: [] }`.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('MarqetaService — Spec 084 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through MarqetaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MarqetaModule],
      }).compile();
      const service = moduleRef.get(MarqetaService);
      expect(service).toBeInstanceOf(MarqetaService);
      await moduleRef.close();
    });

    it('exports the Site.MARQETA = "marqeta" enum value', () => {
      expect(Site.MARQETA).toBe('marqeta');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarqetaService();
      const input: ScraperInputDto = {
        siteType: [Site.MARQETA],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const cx = dto.jobs.find((j) => j.id === 'marqeta-7816181');
      expect(cx).toBeDefined();
      expect(cx?.site).toBe(Site.MARQETA);
      // D-09 omission lock: case-symmetric wire `'Marqeta'`.
      expect(cx?.companyName).toBe('Marqeta');
      expect(cx?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(cx?.companyName?.toLowerCase()).toBe('marqeta');
      // First-listing title clean — D-10 trim no-op.
      expect(cx?.title).toBe('Customer Experience Manager');
      expect(cx?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant 2.
      expect(cx?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/marqeta/jobs/7816181',
      );
      expect(cx?.jobUrl).toContain('job-boards.greenhouse.io/marqeta/jobs/');
      expect(cx?.jobUrl).not.toContain('?gh_jid=');
      // D-11 first-listing pass-through guard.
      expect(cx?.department).toBe('Risk Operations');
      expect(cx?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // Location — Marqeta's Oakland HQ.
      expect(cx?.location?.city).toBe('Oakland, CA');
      expect(cx?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(cx?.description).not.toContain('&lt;');
      expect(cx?.description).not.toContain('&quot;');
      expect(cx?.description).not.toContain('&amp;');
      expect(cx?.description).not.toContain('&#8217;');
      expect(cx?.description).not.toContain('<p>');
      expect(cx?.description).not.toContain('<strong>');
      expect(cx?.description).not.toContain('<span');
      expect(cx?.description).toContain('Marqeta');
      expect(cx?.description).toContain('embedded-payments');

      const fraud = dto.jobs.find((j) => j.id === 'marqeta-7785735');
      expect(fraud).toBeDefined();
      // D-10 application lock — single-trailing-pad form: emitted
      // `title` is the trimmed `'Group Product Manager, Fraud'`
      // (no trailing pad bytes) AND byte-distinct from the wire
      // form `'Group Product Manager, Fraud '` AND exactly 1 byte
      // shorter. Twentieth cohort plugin to apply D-10.
      expect(fraud?.title).toBe('Group Product Manager, Fraud');
      expect(fraud?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Group Product Manager, Fraud ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(fraud?.title.endsWith(' ')).toBe(false);
      expect(fraud?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(fraud?.companyName).toBe('Marqeta');
      // D-11 second-listing pass-through guard — multi-token form
      // with internal whitespace, commas.
      expect(fraud?.department).toBe('Risk, Fraud, Disputes Product');
      expect(fraud?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(fraud?.location?.city).toBe('Remote, USA');
      expect(fraud?.isRemote).toBe(true);
      // Variant-2 lock for second listing.
      expect(fraud?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/marqeta/jobs/7785735',
      );
      expect(fraud?.description).not.toContain('<p>');
      expect(fraud?.description).toContain('Marqeta');
      expect(fraud?.description).toContain('fraud-detection');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/marqeta/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarqetaService();
      const result = await service.scrape({
        siteType: [Site.MARQETA],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarqetaService();
      const result = await service.scrape({
        siteType: [Site.MARQETA],
        searchTerm: 'FRAUD',
      } as ScraperInputDto);

      // The search term `'FRAUD'` matches the second listing's
      // trimmed title `'Group Product Manager, Fraud'` AND its
      // department `'Risk, Fraud, Disputes Product'`. The first
      // listing's title 'Customer Experience Manager' / dept
      // 'Risk Operations' do not contain 'fraud', so it filters
      // out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('marqeta-7785735');
      // Lock D-10 application: emitted title is the trimmed form.
      expect(result.jobs[0].title).toBe('Group Product Manager, Fraud');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new MarqetaService();
      const result = await service.scrape({
        siteType: [Site.MARQETA],
        searchTerm: 'risk operations',
      } as ScraperInputDto);

      // Only the first listing has 'Risk Operations' as its
      // department; the second listing's department 'Risk, Fraud,
      // Disputes Product' contains 'Risk' but not the full
      // substring 'risk operations'.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('marqeta-7816181');
      expect(result.jobs[0].department).toBe('Risk Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new MarqetaService();
      const result = await service.scrape({
        siteType: [Site.MARQETA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new MarqetaService();
      const result = await service.scrape({
        siteType: [Site.MARQETA],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
