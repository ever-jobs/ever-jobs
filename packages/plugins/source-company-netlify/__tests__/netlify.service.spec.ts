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

import { NetlifyModule, NetlifyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'netlify-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 053 / T04 — `NetlifyService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `NetlifyService` through `NetlifyModule`.
 *   2. `Site.NETLIFY === 'netlify'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare `netlify` Greenhouse slug, (b) the description has
 *      named entities (`&quot;`, `&nbsp;`, `&rsquo;`), numeric
 *      entities (`&#39;`), AND tags stripped (D-08), (c) the
 *      `job-boards.greenhouse.io` permalink-subdomain `absolute_url`
 *      flows through byte-for-byte (D-04 — variant 2 US-region
 *      permalink subdomain), (d) the emitted `companyName` is the
 *      brand name `'Netlify'` (D-09 — matches the wire `company_name`
 *      byte-for-byte; no legal-entity suffix to clean), and (e) the
 *      literal-ampersand department name `'R&D'` flows through
 *      byte-for-byte (D-11 — first plugin in cohort with an
 *      ampersand-bearing dept).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name including
 *      the literal-ampersand `R&D` department (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('NetlifyService — Spec 053 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through NetlifyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [NetlifyModule],
      }).compile();
      const service = moduleRef.get(NetlifyService);
      expect(service).toBeInstanceOf(NetlifyService);
      await moduleRef.close();
    });

    it('exports the Site.NETLIFY = "netlify" enum value', () => {
      expect(Site.NETLIFY).toBe('netlify');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetlifyService();
      const input: ScraperInputDto = {
        siteType: [Site.NETLIFY],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ux = dto.jobs.find((j) => j.id === 'netlify-8441719002');
      expect(ux).toBeDefined();
      expect(ux?.site).toBe(Site.NETLIFY);
      // D-09 regression guard: the wire `company_name` is the bare
      // brand name `'Netlify'` (no legal-entity suffix); the emitted
      // `companyName` matches the wire byte-for-byte AND is the
      // string-literal pin in the mapping.
      expect(ux?.companyName).toBe('Netlify');
      expect(ux?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ux?.title).toBe('Senior UX Engineer (Marketing)');
      // Wire shape: Netlify's tenant publishes `absolute_url` on the
      // new `job-boards.greenhouse.io` permalink subdomain — the same
      // wire-shape variant Vercel, Affirm, Gusto, Mercury, and
      // Buildkite use (Spec 053 § 10 D-04 — variant 2, US-region
      // permalink subdomain).
      expect(ux?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/netlify/jobs/8441719002',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) — not the EU-region `job-boards.eu.greenhouse.io`
      // form Ramp Network introduced in Spec 052.
      expect(ux?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(ux?.jobUrl).not.toContain('job-boards.eu.greenhouse.io');
      expect(ux?.location?.city).toBe('Remote');
      // D-11 regression guard: the wire department name is `'R&D'`
      // (literal ASCII ampersand). The plugin pins it byte-for-byte
      // — no entity decode pass on department names (only on the
      // `content` description field per D-08), since dept names are
      // consumer-facing UI text, not HTML-encoded payloads.
      expect(ux?.department).toBe('R&D');
      expect(JOBS_PAGE_RAW.jobs[0].departments[0].name).toBe('R&D');
      expect(ux?.isRemote).toBe(true);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), `&nbsp;` (non-breaking-space named entity not
      // decoded), or literal `<p>`/`<strong>` (tags not stripped after
      // decode).
      expect(ux?.description).not.toContain('&lt;');
      expect(ux?.description).not.toContain('&quot;');
      expect(ux?.description).not.toContain('&#39;');
      expect(ux?.description).not.toContain('&nbsp;');
      expect(ux?.description).not.toContain('<p>');
      expect(ux?.description).not.toContain('<strong>');
      expect(ux?.description).toContain('About the Team');
      expect(ux?.description).toContain('empower developers');
      // Numeric entity (&#39;) decoded to a real apostrophe.
      expect(ux?.description).toContain("you'll drive");
      // Named entity (&rsquo;) decoded to a real right-single-quote.
      expect(ux?.description).toContain('Netlify’s marketing site');

      const talent = dto.jobs.find((j) => j.id === 'netlify-4224129002');
      expect(talent?.isRemote).toBe(true);
      expect(talent?.department).toBe('G&A');
      expect(talent?.location?.city).toBe('Remote');
      expect(talent?.companyName).toBe('Netlify');
      expect(talent?.title).toBe('Your Chance to Join Our Talent Community!');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(talent?.description).not.toContain('<p>');
      // Numeric entity decoded.
      expect(talent?.description).toContain("Don't see");

      // Regression guard: the slug must be `netlify` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/netlify/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetlifyService();
      const input: ScraperInputDto = {
        siteType: [Site.NETLIFY],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetlifyService();
      const result = await service.scrape({
        siteType: [Site.NETLIFY],
        searchTerm: 'TALENT',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('netlify-4224129002');
    });

    it('filters by case-insensitive substring of department name including literal ampersand', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NetlifyService();
      const result = await service.scrape({
        siteType: [Site.NETLIFY],
        searchTerm: 'r&d',
      } as ScraperInputDto);

      // D-11 regression guard: the case-insensitive `searchTerm`
      // filter on `'r&d'` must match the literal-ampersand `'R&D'`
      // department byte-for-byte (the ampersand passes through both
      // the `searchTerm` lowercase pass and the dept-name lowercase
      // pass without escaping).
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('netlify-8441719002');
      expect(result.jobs[0].department).toBe('R&D');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new NetlifyService();
      const result = await service.scrape({
        siteType: [Site.NETLIFY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new NetlifyService();
      const result = await service.scrape({
        siteType: [Site.NETLIFY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
