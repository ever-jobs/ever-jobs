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

import { ScaleaiModule, ScaleaiService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'scaleai-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 064 / T04 — `ScaleaiService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ScaleaiService` through `ScaleaiModule`.
 *   2. `Site.SCALEAI === 'scaleai'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the slug-form `scaleai` Greenhouse slug, (b) the description
 *      has named entities (`&quot;`), numeric entities (`&#39;`), AND
 *      tags stripped (D-08), (c) the variant-2 US-region permalink
 *      `absolute_url` flows through byte-for-byte (D-04 —
 *      `job-boards.greenhouse.io/scaleai/jobs/<id>` shape), (d) the
 *      emitted `companyName` is the multi-token bare-brand display
 *      `'Scale AI'` byte-for-byte (with internal ASCII space) AND
 *      matches the wire `company_name` byte-for-byte (D-09 omission
 *      lock — regression guard against the upstream tenant adding a
 *      future legal-entity suffix), (e) the emitted `title` matches
 *      the wire `title` byte-for-byte (D-10 omission lock — no
 *      observable `.trim()`), and (f) the emitted `department` for
 *      the first listing matches the wire `departments[0].name`
 *      byte-for-byte (D-11 first-instance pass-through guard for the
 *      multi-word descriptive department format with initialism).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive
 *      — including the literal `'gps'` substring matching the
 *      multi-word department `'GPS Sales'` in the first listing — D-11
 *      multi-word search guard with initialism).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ScaleaiService — Spec 064 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ScaleaiModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ScaleaiModule],
      }).compile();
      const service = moduleRef.get(ScaleaiService);
      expect(service).toBeInstanceOf(ScaleaiService);
      await moduleRef.close();
    });

    it('exports the Site.SCALEAI = "scaleai" enum value', () => {
      expect(Site.SCALEAI).toBe('scaleai');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScaleaiService();
      const input: ScraperInputDto = {
        siteType: [Site.SCALEAI],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ops = dto.jobs.find((j) => j.id === 'scaleai-4686014005');
      expect(ops).toBeDefined();
      expect(ops?.site).toBe(Site.SCALEAI);
      // D-09 omission lock: the emitted `companyName` is the
      // multi-token bare-brand display `'Scale AI'` byte-for-byte
      // (with internal ASCII space) AND matches the wire
      // `company_name` byte-for-byte (locking the wire-shape
      // regression guard against the upstream tenant adding a future
      // legal-entity suffix). The plugin reads `listing.company_name`
      // directly. First cohort plugin to omit D-09 against a multi-
      // token bare-brand wire (every prior D-09-omission was single-
      // word — Mixpanel `'Mixpanel'`, Faire `'Faire'`, etc.).
      expect(ops?.companyName).toBe('Scale AI');
      expect(ops?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // Lock the internal-whitespace asymmetry between the slug
      // (`scaleai`) and the wire `company_name` (`Scale AI`).
      expect(ops?.companyName).toContain(' ');
      // D-10 omission lock: emitted `title` matches the wire `title`
      // byte-for-byte (no observable `.trim()`). The fixture title
      // `'AI Applications Ops Lead, GPS'` is already trim-clean (no
      // leading or trailing whitespace).
      expect(ops?.title).toBe('AI Applications Ops Lead, GPS');
      expect(ops?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // Wire shape: Scale AI's tenant publishes `absolute_url` on the
      // US-region permalink subdomain `job-boards.greenhouse.io/
      // scaleai/jobs/<id>` — variant 2 (the twelfth plugin in the
      // cohort to use this shape) (Spec 064 § 10 D-04).
      expect(ops?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/scaleai/jobs/4686014005',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `job-boards.greenhouse.io` substring (US-region permalink
      // subdomain) AND the literal `/scaleai/jobs/` substring (the
      // path-with-`jobs`-segment listing identification) AND must NOT
      // contain `?gh_jid=` (locking the variant-2 shape against future
      // refactors that might naively normalise to a variant-10 or
      // variant-11 template).
      expect(ops?.jobUrl).toContain('job-boards.greenhouse.io');
      expect(ops?.jobUrl).toContain('/scaleai/jobs/');
      expect(ops?.jobUrl).not.toContain('?gh_jid=');
      expect(ops?.location?.city).toBe('San Francisco, CA');
      // D-11 regression guard: the emitted `department` for the first
      // fixture listing is the multi-word string `'GPS Sales'`
      // byte-for-byte (with initialism + plain word) AND matches the
      // wire `departments[0].name` byte-for-byte. Scale AI uses
      // multi-word descriptive department names with initialisms,
      // distinct from Mixpanel's flat single-token format and Toast's
      // colon-separated nested-path format.
      expect(ops?.department).toBe('GPS Sales');
      expect(ops?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ops?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&#39;` (numeric entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<em>` (tags not
      // stripped after decode).
      expect(ops?.description).not.toContain('&lt;');
      expect(ops?.description).not.toContain('&quot;');
      expect(ops?.description).not.toContain('&#39;');
      expect(ops?.description).not.toContain('<p>');
      expect(ops?.description).not.toContain('<div>');
      expect(ops?.description).not.toContain('<strong>');
      expect(ops?.description).not.toContain('<em>');
      // Sanity: the role-specific body content survives the strip.
      expect(ops?.description).toContain('Scale AI');
      expect(ops?.description).toContain('Global Public Sector');
      expect(ops?.description).toContain('Scale Donovan');

      const eng = dto.jobs.find((j) => j.id === 'scaleai-4719882005');
      expect(eng).toBeDefined();
      expect(eng?.title).toBe('Applied AI Engineer, Enterprise GenAI');
      // D-10 omission: this fixture title is already trim-clean.
      expect(eng?.title).toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(eng?.companyName).toBe('Scale AI');
      expect(eng?.location?.city).toBe('Remote, United States');
      // The fixture location string contains "Remote" so isRemote
      // should be true.
      expect(eng?.isRemote).toBe(true);
      // D-11 second-instance pass-through guard for the multi-word
      // department format — distinct token from the first listing
      // (`'Engineering'` is single-token, but the field still
      // pass-through wire byte-for-byte).
      expect(eng?.department).toBe('Engineering');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(eng?.description).not.toContain('<p>');
      expect(eng?.description).toContain('Enterprise GenAI');
      expect(eng?.description).toContain('Scale GenAI Platform');

      // Regression guard: the slug must be `scaleai` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/scaleai/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScaleaiService();
      const input: ScraperInputDto = {
        siteType: [Site.SCALEAI],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScaleaiService();
      const result = await service.scrape({
        siteType: [Site.SCALEAI],
        searchTerm: 'ENGINEER',
      } as ScraperInputDto);

      // Only the second fixture job has 'Engineer' in its title
      // (`'Applied AI Engineer, Enterprise GenAI'`); the case-
      // insensitive match on the literal `'ENGINEER'` substring
      // matches the second listing's title byte-for-byte.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('scaleai-4719882005');
      expect(result.jobs[0].title).toBe('Applied AI Engineer, Enterprise GenAI');
    });

    it('filters by case-insensitive substring of multi-word department name (D-11 GPS-initialism guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScaleaiService();
      const result = await service.scrape({
        siteType: [Site.SCALEAI],
        searchTerm: 'gps',
      } as ScraperInputDto);

      // Only the first fixture job has `'GPS Sales'` as its
      // multi-word department; the case-insensitive match on the
      // literal `'gps'` substring matches the literal `'GPS'`
      // initialism in the first listing's department byte-for-byte.
      // The second listing's title-search miss ('Applied AI Engineer,
      // Enterprise GenAI' does not contain 'gps') and dept miss
      // ('Engineering' does not contain 'gps') filter it out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('scaleai-4686014005');
      expect(result.jobs[0].department).toBe('GPS Sales');
    });

    it('filters by case-insensitive substring of department name on second listing — D-11 engineering lock', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScaleaiService();
      const result = await service.scrape({
        siteType: [Site.SCALEAI],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      // Only the second fixture job has `'Engineering'` as its
      // department; the case-insensitive match on the literal
      // `'engineering'` substring matches the literal `'Engineering'`
      // department name in the second listing. Note: the first
      // listing's title match is also possible if 'engineering' were
      // in the title, but it is not — the first listing's title is
      // `'AI Applications Ops Lead, GPS'`. So only the second listing
      // matches.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('scaleai-4719882005');
      expect(result.jobs[0].department).toBe('Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ScaleaiService();
      const result = await service.scrape({
        siteType: [Site.SCALEAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ScaleaiService();
      const result = await service.scrape({
        siteType: [Site.SCALEAI],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
