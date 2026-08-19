import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture
// rather than the live Greenhouse public API.
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

import { ToastModule, ToastService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'toast-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 055 / T04 — `ToastService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ToastService` through `ToastModule`.
 *   2. `Site.TOAST === 'toast'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `toast` Greenhouse slug, (b) the description has
 *      named entities (`&amp;nbsp;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-8 careers-subdomain on a
 *      sub-brand product domain `absolute_url` flows through byte-for-
 *      byte (D-04 — `careers.toasttab.com/jobs?gh_jid=<id>` shape),
 *      (d) the emitted `companyName` is the brand name `'Toast'` (D-09
 *      — matches the wire `company_name` byte-for-byte; no legal-entity
 *      suffix to clean), and (e) the emitted `department` for the first
 *      listing is the colon-separated nested path
 *      `'Sales : International : Horizon 2'` byte-for-byte (D-11 first-
 *      instance pass-through guard).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the colon-nested path leaf, e.g. `'horizon'` matches
 *      the literal `'Horizon 2'` leaf segment in the first listing's
 *      department path).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ToastService — Spec 055 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ToastModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ToastModule],
      }).compile();
      const service = moduleRef.get(ToastService);
      expect(service).toBeInstanceOf(ToastService);
      await moduleRef.close();
    });

    it('exports the Site.TOAST = "toast" enum value', () => {
      expect(Site.TOAST).toBe('toast');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ToastService();
      const input: ScraperInputDto = {
        siteType: [Site.TOAST],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ae = dto.jobs.find((j) => j.id === 'toast-7384733');
      expect(ae).toBeDefined();
      expect(ae?.site).toBe(Site.TOAST);
      // D-09 regression guard: the wire `company_name` is the bare
      // brand name `'Toast'` (no legal-entity suffix); the emitted
      // `companyName` matches the wire byte-for-byte AND is the
      // string-literal pin in the mapping.
      expect(ae?.companyName).toBe('Toast');
      expect(ae?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ae?.title).toBe('Account Executive - Melbourne');
      // Wire shape: Toast's tenant publishes `absolute_url` on the
      // careers-subdomain on a sub-brand product domain
      // `careers.toasttab.com/jobs?gh_jid=<id>` — variant 8 (the first
      // plugin in the cohort to use a sub-brand product domain rather
      // than the slug-name brand domain) (Spec 055 § 10 D-04).
      expect(ae?.jobUrl).toBe(
        'https://careers.toasttab.com/jobs?gh_jid=7384733',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `careers.toasttab.com` substring (variant-8 sub-brand-domain
      // careers-subdomain) AND the literal `?gh_jid=` substring (the
      // query-param-only listing identification) AND must NOT contain
      // `job-boards.greenhouse.io` (locking the variant-8 shape against
      // future refactors that might naively normalise to a permalink-
      // subdomain template).
      expect(ae?.jobUrl).toContain('careers.toasttab.com');
      expect(ae?.jobUrl).toContain('?gh_jid=');
      expect(ae?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(ae?.location?.city).toBe('Melbourne, Australia');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the colon-separated nested path
      // `'Sales : International : Horizon 2'` byte-for-byte AND matches
      // the wire `departments[0].name` byte-for-byte (Toast is the
      // first plugin in the cohort to ship a fixture with colon-
      // separated nested-path department names).
      expect(ae?.department).toBe('Sales : International : Horizon 2');
      expect(ae?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&amp;nbsp;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<strong>`/`<em>` (tags not stripped
      // after decode).
      expect(ae?.description).not.toContain('&lt;');
      expect(ae?.description).not.toContain('&amp;nbsp;');
      expect(ae?.description).not.toContain('&#39;');
      expect(ae?.description).not.toContain('<p>');
      expect(ae?.description).not.toContain('<strong>');
      expect(ae?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(ae?.description).toContain('Toast POS');
      expect(ae?.description).toContain('Account Executive');
      expect(ae?.description).toContain('Melbourne');

      const bdr = dto.jobs.find((j) => j.id === 'toast-6869373');
      expect(bdr).toBeDefined();
      expect(bdr?.title).toBe('Bilingual Business Development Representative (Mandarin)');
      expect(bdr?.companyName).toBe('Toast');
      expect(bdr?.location?.city).toBe('Remote - US (PST time zone)');
      // The fixture location string contains "Remote" so isRemote
      // should be true.
      expect(bdr?.isRemote).toBe(true);
      // Different leaf, same Sales root, exercising the nested-path
      // diversity (D-11 second-instance pass-through guard).
      expect(bdr?.department).toBe('Sales : Sales Acceleration');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(bdr?.description).not.toContain('<p>');
      expect(bdr?.description).toContain('Bilingual Business Development Representative');
      expect(bdr?.description).toContain('Mandarin');

      // Regression guard: the slug must be `toast` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/toast/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ToastService();
      const input: ScraperInputDto = {
        siteType: [Site.TOAST],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ToastService();
      const result = await service.scrape({
        siteType: [Site.TOAST],
        searchTerm: 'MANDARIN',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('toast-6869373');
    });

    it('filters by case-insensitive substring of department name (D-11 nested-path-search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ToastService();
      const result = await service.scrape({
        siteType: [Site.TOAST],
        searchTerm: 'horizon',
      } as ScraperInputDto);

      // Only the first fixture job has `'Horizon 2'` as a leaf segment
      // in its colon-separated nested-path department; the case-
      // insensitive match on the literal `'horizon'` substring matches
      // the literal `'Horizon 2'` leaf segment in the first listing's
      // department path.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('toast-7384733');
      expect(result.jobs[0].department).toBe('Sales : International : Horizon 2');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ToastService();
      const result = await service.scrape({
        siteType: [Site.TOAST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ToastService();
      const result = await service.scrape({
        siteType: [Site.TOAST],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
