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

import { WebflowModule, WebflowService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'webflow-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 056 / T04 — `WebflowService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `WebflowService` through `WebflowModule`.
 *   2. `Site.WEBFLOW === 'webflow'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `webflow` Greenhouse slug, (b) the description has
 *      named entities (`&rsquo;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-2 `job-boards.greenhouse
 *      .io/webflow/jobs/<id>` `absolute_url` flows through byte-for-
 *      byte (D-04), (d) the emitted `companyName` is the brand name
 *      `'Webflow'` (D-09), and (e) the multi-region remote
 *      `location.city` is `'CA Remote (BC & ON only); U.K. / Ireland
 *      Remote; U.S. Remote'` byte-for-byte (D-11 first-instance
 *      pass-through guard for the semicolon-separated multi-region
 *      location format).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('WebflowService — Spec 056 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through WebflowModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [WebflowModule],
      }).compile();
      const service = moduleRef.get(WebflowService);
      expect(service).toBeInstanceOf(WebflowService);
      await moduleRef.close();
    });

    it('exports the Site.WEBFLOW = "webflow" enum value', () => {
      expect(Site.WEBFLOW).toBe('webflow');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new WebflowService();
      const input: ScraperInputDto = {
        siteType: [Site.WEBFLOW],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const bdr = dto.jobs.find((j) => j.id === 'webflow-7826080');
      expect(bdr).toBeDefined();
      expect(bdr?.site).toBe(Site.WEBFLOW);
      // D-09 regression guard: bare brand name byte-for-byte against wire.
      expect(bdr?.companyName).toBe('Webflow');
      expect(bdr?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(bdr?.title).toBe('Business Development Representative');
      // Wire shape: variant 2 (US-region permalink subdomain).
      expect(bdr?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/webflow/jobs/7826080',
      );
      expect(bdr?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(bdr?.jobUrl).not.toContain('job-boards.eu.greenhouse.io');
      expect(bdr?.location?.city).toBe('Chicago, U.S. (Hybrid)');
      expect(bdr?.department).toBe('Sales');
      expect(bdr?.isRemote).toBe(false);
      // D-08 regression guard: decode-then-strip pipeline.
      expect(bdr?.description).not.toContain('&lt;');
      expect(bdr?.description).not.toContain('&rsquo;');
      expect(bdr?.description).not.toContain('&#39;');
      expect(bdr?.description).not.toContain('<p>');
      expect(bdr?.description).not.toContain('<strong>');
      expect(bdr?.description).not.toContain('<em>');
      // Sanity: role-specific body content survives the strip.
      expect(bdr?.description).toContain('Business Development Representative');
      expect(bdr?.description).toContain('Webflow Designer');
      expect(bdr?.description).toContain('Account Executives');

      const em = dto.jobs.find((j) => j.id === 'webflow-7532377');
      expect(em).toBeDefined();
      expect(em?.title).toBe('Engineering Manager, Code Sync');
      expect(em?.companyName).toBe('Webflow');
      // D-11 regression guard: semicolon-separated multi-region remote
      // location pass-through. Webflow is the first plugin in the
      // cohort to ship a fixture with this format.
      expect(em?.location?.city).toBe(
        'CA Remote (BC & ON only); U.K. / Ireland Remote; U.S. Remote',
      );
      expect(em?.location?.city).toBe(JOBS_PAGE_RAW.jobs[1].location.name);
      // The wire location string contains "Remote" so isRemote should
      // be true even for the multi-region form.
      expect(em?.isRemote).toBe(true);
      expect(em?.department).toBe('Engineering');
      // Tags stripped after decode.
      expect(em?.description).not.toContain('<p>');
      expect(em?.description).not.toContain('<em>');
      expect(em?.description).toContain('Engineering Manager');
      expect(em?.description).toContain('Code Sync');

      // Regression guard: the slug must be `webflow` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/webflow/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new WebflowService();
      const input: ScraperInputDto = {
        siteType: [Site.WEBFLOW],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new WebflowService();
      const result = await service.scrape({
        siteType: [Site.WEBFLOW],
        searchTerm: 'CODE SYNC',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('webflow-7532377');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new WebflowService();
      const result = await service.scrape({
        siteType: [Site.WEBFLOW],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('webflow-7532377');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new WebflowService();
      const result = await service.scrape({
        siteType: [Site.WEBFLOW],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new WebflowService();
      const result = await service.scrape({
        siteType: [Site.WEBFLOW],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
