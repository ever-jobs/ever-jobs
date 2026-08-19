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

import { GlossierModule, GlossierService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'glossier-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 072 / T04 — `GlossierService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `GlossierService` through `GlossierModule`.
 *   2. `Site.GLOSSIER === 'glossier'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `glossier`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-10 legacy hosted-board
 *      `boards.greenhouse.io/glossier/jobs/<id>?gh_jid=<id>`
 *      `absolute_url` flows through byte-for-byte (D-04 — fourth
 *      plugin in the cohort to use variant 10), (d) the emitted
 *      `companyName` is the single-token bare-brand `'Glossier'`
 *      byte-for-byte AND matches the wire `company_name`
 *      byte-for-byte (D-09 omission lock), (e) **D-10 multi-byte
 *      trim lock** — the emitted `title` for the SECOND listing
 *      equals trimmed form
 *      `'(Seasonal Sales Associate, Part-Time) Editor, Boston'` AND
 *      is byte-distinct from wire-padded form
 *      `'(Seasonal Sales Associate, Part-Time) Editor, Boston  '`
 *      AND is exactly **2 bytes shorter** (locking the multi-byte
 *      trailing-pad form first observed in this cohort), (f) the
 *      emitted `department` for the FIRST listing matches the wire
 *      `departments[0].name` byte-for-byte (`'Retail (Stores)'` —
 *      clean multi-token form with internal parentheses, D-11 pass-
 *      through), and (g) the emitted `department` for the SECOND
 *      listing matches the wire `departments[0].name` byte-for-
 *      byte (`'Creative'` — clean single-token form, D-11 pass-
 *      through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('GlossierService — Spec 072 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through GlossierModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GlossierModule],
      }).compile();
      const service = moduleRef.get(GlossierService);
      expect(service).toBeInstanceOf(GlossierService);
      await moduleRef.close();
    });

    it('exports the Site.GLOSSIER = "glossier" enum value', () => {
      expect(Site.GLOSSIER).toBe('glossier');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GlossierService();
      const input: ScraperInputDto = {
        siteType: [Site.GLOSSIER],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const asd = dto.jobs.find((j) => j.id === 'glossier-7821754');
      expect(asd).toBeDefined();
      expect(asd?.site).toBe(Site.GLOSSIER);
      // D-09 omission lock: the emitted `companyName` is the
      // single-token bare-brand `'Glossier'` byte-for-byte AND
      // matches the wire `company_name` byte-for-byte. Twenty-
      // second cohort plugin to omit D-09.
      expect(asd?.companyName).toBe('Glossier');
      expect(asd?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // First-listing title is wire-clean — trim is a no-op here, so
      // emitted `title` matches the wire `title` byte-for-byte.
      expect(asd?.title).toBe('Associate Store Director, DC');
      expect(asd?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Glossier's tenant publishes `absolute_url` on
      // wire-shape variant 10 — the legacy hosted-board apex
      // `https://boards.greenhouse.io/glossier/jobs/<id>?gh_jid=<id>`.
      // The plugin emits `listing.absolute_url` byte-for-byte.
      // Fourth plugin in the cohort to use variant 10 (after Chime,
      // Faire, and Flexport).
      expect(asd?.jobUrl).toBe(
        'https://boards.greenhouse.io/glossier/jobs/7821754?gh_jid=7821754',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `boards.greenhouse.io/glossier/jobs/` substring (variant-10
      // legacy hosted-board apex) AND the literal `?gh_jid=` query
      // parameter AND must NOT contain `job-boards.greenhouse.io`
      // (locking the variant-10 shape against future refactors that
      // might naively normalise to variant 2).
      expect(asd?.jobUrl).toContain('boards.greenhouse.io/glossier/jobs/');
      expect(asd?.jobUrl).toContain('?gh_jid=');
      expect(asd?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Location is wire-clean for Glossier (D-12 not applied).
      expect(asd?.location?.city).toBe('Washington, DC');
      // D-11 first-listing regression guard: the emitted
      // `department` for the first fixture listing matches the wire
      // `departments[0].name === 'Retail (Stores)'` byte-for-byte
      // (clean multi-token form with internal parentheses; pass-
      // through preserves byte-fidelity to the wire shape).
      expect(asd?.department).toBe('Retail (Stores)');
      expect(asd?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(asd?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half
      // is missing we'd see literal `&lt;` (entities not decoded),
      // `&quot;` (named entities not decoded), `&amp;` (ampersand
      // entities not decoded), or literal `<p>`/`<div>`/`<strong>`/
      // `<em>` (tags not stripped after decode).
      expect(asd?.description).not.toContain('&lt;');
      expect(asd?.description).not.toContain('&quot;');
      expect(asd?.description).not.toContain('&amp;');
      expect(asd?.description).not.toContain('<p>');
      expect(asd?.description).not.toContain('<div>');
      expect(asd?.description).not.toContain('<strong>');
      expect(asd?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(asd?.description).toContain('Glossier');
      expect(asd?.description).toContain('Retail (Stores)');

      const sea = dto.jobs.find((j) => j.id === 'glossier-7787412');
      expect(sea).toBeDefined();
      // D-10 application lock — multi-byte trailing-pad form: the
      // emitted `title` for the second listing equals the trimmed
      // form `'(Seasonal Sales Associate, Part-Time) Editor, Boston'`
      // (no trailing pad bytes) AND is byte-distinct from the wire
      // form `'(Seasonal Sales Associate, Part-Time) Editor, Boston  '`
      // (with TWO trailing pad bytes) AND is exactly 2 bytes
      // shorter. Locking the multi-byte trim — first cohort plugin
      // to exercise the double-trailing-pad path. Thirteenth cohort
      // plugin to apply D-10.
      expect(sea?.title).toBe('(Seasonal Sales Associate, Part-Time) Editor, Boston');
      expect(sea?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        '(Seasonal Sales Associate, Part-Time) Editor, Boston  ',
      );
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith('  ')).toBe(true);
      expect(sea?.title.endsWith(' ')).toBe(false);
      expect(sea?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 2);
      expect(sea?.companyName).toBe('Glossier');
      expect(sea?.location?.city).toBe('Boston, MA');
      expect(sea?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted
      // `department` for the second fixture listing matches the
      // wire `departments[0].name === 'Creative'` byte-for-byte
      // (clean single-token form; pass-through preserves byte-
      // fidelity to the wire shape).
      expect(sea?.department).toBe('Creative');
      expect(sea?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      // Variant-10 lock for the second listing too.
      expect(sea?.jobUrl).toBe(
        'https://boards.greenhouse.io/glossier/jobs/7787412?gh_jid=7787412',
      );
      expect(sea?.jobUrl).toContain('boards.greenhouse.io/glossier/jobs/');
      expect(sea?.jobUrl).toContain('?gh_jid=');
      expect(sea?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(sea?.description).not.toContain('<p>');
      expect(sea?.description).not.toContain('<strong>');
      expect(sea?.description).toContain('Seasonal Sales Associate');
      expect(sea?.description).toContain('Creative');

      // Regression guard: the slug must be `glossier` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/glossier/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GlossierService();
      const input: ScraperInputDto = {
        siteType: [Site.GLOSSIER],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GlossierService();
      const result = await service.scrape({
        siteType: [Site.GLOSSIER],
        searchTerm: 'SEASONAL',
      } as ScraperInputDto);

      // Only the second fixture job has 'Seasonal' in its title
      // (trimmed `'(Seasonal Sales Associate, Part-Time) Editor,
      // Boston'`); the case-insensitive match on the literal
      // `'SEASONAL'` substring matches the trimmed second listing's
      // title byte-for-byte. The first listing's title ('Associate
      // Store Director, DC') and dept ('Retail (Stores)') do not
      // contain 'seasonal', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('glossier-7787412');
      // Lock the D-10 application observable — the emitted title
      // for the matched listing carries the trimmed form (no pad
      // bytes).
      expect(result.jobs[0].title).toBe('(Seasonal Sales Associate, Part-Time) Editor, Boston');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new GlossierService();
      const result = await service.scrape({
        siteType: [Site.GLOSSIER],
        searchTerm: 'creative',
      } as ScraperInputDto);

      // Only the second fixture job has `'Creative'` as its
      // department; the case-insensitive match on the literal
      // `'creative'` substring matches the literal `'Creative'`
      // department name. The first listing's title ('Associate
      // Store Director, DC') and dept ('Retail (Stores)') do not
      // contain 'creative', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('glossier-7787412');
      expect(result.jobs[0].department).toBe('Creative');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new GlossierService();
      const result = await service.scrape({
        siteType: [Site.GLOSSIER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new GlossierService();
      const result = await service.scrape({
        siteType: [Site.GLOSSIER],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
