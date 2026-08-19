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

import { RampNetworkModule, RampNetworkService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'rampnetwork-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 052 / T04 — `RampNetworkService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `RampNetworkService` through `RampNetworkModule`.
 *   2. `Site.RAMPNETWORK === 'rampnetwork'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `rampnetwork` Greenhouse slug, (b) the description has
 *      both entities decoded AND tags stripped (D-08), (c) the
 *      variant-6 wire-shape
 *      `https://job-boards.eu.greenhouse.io/rampnetwork/jobs/<id>`
 *      `absolute_url` flows through to `jobUrl` byte-for-byte (D-04),
 *      (d) the emitted `jobUrl` contains the literal
 *      `job-boards.eu.greenhouse.io` substring (EU-region-subdomain
 *      lock — D-04), and (e) the emitted `companyName` is the brand
 *      name `'Ramp Network'` (D-09 — matches the wire `company_name`
 *      byte-for-byte; no legal-entity suffix to clean; first plugin to
 *      pin a multi-word brand-name string literal containing an
 *      inter-word ASCII space).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('RampNetworkService — Spec 052 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through RampNetworkModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [RampNetworkModule],
      }).compile();
      const service = moduleRef.get(RampNetworkService);
      expect(service).toBeInstanceOf(RampNetworkService);
      await moduleRef.close();
    });

    it('exports the Site.RAMPNETWORK = "rampnetwork" enum value', () => {
      expect(Site.RAMPNETWORK).toBe('rampnetwork');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RampNetworkService();
      const input: ScraperInputDto = {
        siteType: [Site.RAMPNETWORK],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const fin = dto.jobs.find((j) => j.id === 'rampnetwork-4830509101');
      expect(fin).toBeDefined();
      expect(fin?.site).toBe(Site.RAMPNETWORK);
      // D-09 regression guard: the wire `company_name` is the bare
      // multi-word brand name `'Ramp Network'` (no legal-entity suffix);
      // the emitted `companyName` matches the wire byte-for-byte AND is
      // the string-literal pin in the mapping. First plugin in the
      // cohort to pin a multi-word brand-name string literal
      // containing an inter-word ASCII space.
      expect(fin?.companyName).toBe('Ramp Network');
      expect(fin?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(fin?.companyName).toContain(' ');
      expect(fin?.title).toBe('Senior Management Accountant - 6 month FTC');
      // Wire shape: Ramp Network's tenant publishes `absolute_url` on
      // the EU-region permalink subdomain `job-boards.eu.greenhouse.io`
      // — the **sixth** distinct wire-shape variant in the cohort and
      // the first plugin to publish on the EU-region subdomain (Spec
      // 052 § 10 D-04).
      expect(fin?.jobUrl).toBe(
        'https://job-boards.eu.greenhouse.io/rampnetwork/jobs/4830509101',
      );
      // D-04 regression guard: the emitted `jobUrl` MUST contain the
      // EU-region subdomain literal (locking the EU-region
      // `job-boards.eu.greenhouse.io` shape against future refactors
      // that might naively normalise to the US-region
      // `job-boards.greenhouse.io` subdomain).
      expect(fin?.jobUrl).toContain('job-boards.eu.greenhouse.io');
      expect(fin?.jobUrl?.startsWith('https://')).toBe(true);
      expect(fin?.location?.city).toBe('Poland Remote');
      expect(fin?.department).toBe('Finance');
      expect(fin?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded) or
      // literal `<p>`/`<h3>` (tags not stripped after decode).
      expect(fin?.description).not.toContain('&lt;');
      expect(fin?.description).not.toContain('&quot;');
      expect(fin?.description).not.toContain('<p>');
      expect(fin?.description).not.toContain('<h2');
      expect(fin?.description).toContain('Join the Web3 revolution');
      // Numeric entity (`&amp;#39;` → `&#39;` → `'`) decoded to ASCII
      // apostrophe.
      expect(fin?.description).toContain("can't stop");
      // Named entity (`&amp;rsquo;` → `&rsquo;` → `'` U+2019) decoded
      // to a real right-single-quote.
      expect(fin?.description).toContain('We’re looking');
      // mdash (`&amp;mdash;` → `&mdash;` → `—`) decoded.
      expect(fin?.description).toContain('—');

      const eng = dto.jobs.find((j) => j.id === 'rampnetwork-4830509202');
      expect(eng?.isRemote).toBe(false);
      expect(eng?.department).toBe('Engineering');
      expect(eng?.location?.city).toBe('London, United Kingdom');
      expect(eng?.companyName).toBe('Ramp Network');
      expect(eng?.title).toBe('Staff Engineer, Compliance Platform');
      expect(eng?.jobUrl).toBe(
        'https://job-boards.eu.greenhouse.io/rampnetwork/jobs/4830509202',
      );
      expect(eng?.jobUrl).toContain('job-boards.eu.greenhouse.io');
      expect(eng?.description).toContain('Compliance Platform');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');
      // mdash decoded in second listing too.
      expect(eng?.description).toContain('—');

      // Regression guard: the slug must be `rampnetwork` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/rampnetwork/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RampNetworkService();
      const input: ScraperInputDto = {
        siteType: [Site.RAMPNETWORK],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RampNetworkService();
      const result = await service.scrape({
        siteType: [Site.RAMPNETWORK],
        searchTerm: 'ACCOUNTANT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('rampnetwork-4830509101');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new RampNetworkService();
      const result = await service.scrape({
        siteType: [Site.RAMPNETWORK],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('rampnetwork-4830509202');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new RampNetworkService();
      const result = await service.scrape({
        siteType: [Site.RAMPNETWORK],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new RampNetworkService();
      const result = await service.scrape({
        siteType: [Site.RAMPNETWORK],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
