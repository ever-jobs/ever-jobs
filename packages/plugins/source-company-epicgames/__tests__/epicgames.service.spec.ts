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

import { EpicgamesModule, EpicgamesService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'epicgames-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 069 / T04 — `EpicgamesService` unit tests.
 *
 * Coverage (≥ 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `EpicgamesService` through `EpicgamesModule`.
 *   2. `Site.EPICGAMES === 'epicgames'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions that (a) the fetched URL uses
 *      the bare slug `epicgames`, (b) the description has named
 *      entities (`&quot;`), numeric entities (`&#39;`), AND tags
 *      stripped (D-08), (c) the variant-13
 *      `epicgames.com/careers/jobs/<id>?gh_jid=<id>` `absolute_url`
 *      flows through byte-for-byte (D-04), (d) the emitted
 *      `companyName` is the multi-token bare-brand display
 *      `'Epic Games'` byte-for-byte AND matches the wire
 *      `company_name` byte-for-byte (D-09 omission lock — the
 *      multi-token wire form is preserved without a `.trim()`),
 *      (e) the emitted `title` for the second listing equals the
 *      trimmed form `'Partnerships Director - Sports & Talent'` AND
 *      is byte-distinct from the wire-padded form (D-10 application
 *      lock), (f) the emitted `department` for the FIRST listing
 *      matches the wire `departments[0].name` byte-for-byte
 *      (`'Art'` — clean single-token form, D-11 pass-through), and
 *      (g) the emitted `department` for the SECOND listing matches
 *      the wire `departments[0].name` byte-for-byte (`'Partnerships'`
 *      — clean single-token form, D-11 pass-through).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive).
 *   6. `searchTerm` filters listings by department name (case-insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('EpicgamesService — Spec 069 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through EpicgamesModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [EpicgamesModule],
      }).compile();
      const service = moduleRef.get(EpicgamesService);
      expect(service).toBeInstanceOf(EpicgamesService);
      await moduleRef.close();
    });

    it('exports the Site.EPICGAMES = "epicgames" enum value', () => {
      expect(Site.EPICGAMES).toBe('epicgames');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EpicgamesService();
      const input: ScraperInputDto = {
        siteType: [Site.EPICGAMES],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(Object);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const concept = dto.jobs.find((j) => j.id === 'epicgames-5711341004');
      expect(concept).toBeDefined();
      expect(concept?.site).toBe(Site.EPICGAMES);
      // D-09 omission lock: the emitted `companyName` is the
      // multi-token bare-brand display `'Epic Games'` byte-for-byte
      // AND matches the wire `company_name` byte-for-byte (multi-token
      // form preserved without a `.trim()`). Nineteenth cohort plugin
      // to omit D-09; second cohort plugin (after Scale AI) to ship
      // with a multi-token bare-brand wire `company_name`.
      expect(concept?.companyName).toBe('Epic Games');
      expect(concept?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      // First-listing wire title is trim-clean — emitted byte-for-byte.
      expect(concept?.title).toBe('Concept Outsource Lead');
      expect(concept?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: Epic Games's tenant publishes `absolute_url` on
      // wire-shape variant 13 — the bare brand-domain shape
      // `https://epicgames.com/careers/jobs/<id>?gh_jid=<id>`. The
      // plugin emits `listing.absolute_url` byte-for-byte.
      expect(concept?.jobUrl).toBe(
        'https://epicgames.com/careers/jobs/5711341004?gh_jid=5711341004',
      );
      // D-04 lock: emitted `jobUrl` must contain the literal
      // `epicgames.com/careers/jobs/` substring (variant-13 vanity-
      // domain shape) — locking the variant-13 shape against future
      // refactors that might naively normalise to the canonical
      // Greenhouse subdomain.
      expect(concept?.jobUrl).toContain('epicgames.com/careers/jobs/');
      expect(concept?.location?.city).toBe('Cary,North Carolina,United States');
      // D-11 first-listing regression guard: the emitted `department`
      // for the first fixture listing matches the wire
      // `departments[0].name === 'Art'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity to
      // the wire shape).
      expect(concept?.department).toBe('Art');
      expect(concept?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(concept?.isRemote).toBe(false);
      // D-08 regression guard: the description-cleanup pipeline must
      // decode HTML entities BEFORE stripping tags. If either half is
      // missing we'd see literal `&lt;` (entities not decoded), `&quot;`
      // (named entities not decoded), `&amp;` (ampersand entities not
      // decoded), or literal `<p>`/`<div>`/`<strong>`/`<h2>` (tags
      // not stripped after decode).
      expect(concept?.description).not.toContain('&lt;');
      expect(concept?.description).not.toContain('&quot;');
      expect(concept?.description).not.toContain('&amp;');
      expect(concept?.description).not.toContain('<p>');
      expect(concept?.description).not.toContain('<div>');
      expect(concept?.description).not.toContain('<strong>');
      expect(concept?.description).not.toContain('<h2>');
      // Sanity: the role-specific body content survives the strip.
      expect(concept?.description).toContain('Epic');
      expect(concept?.description).toContain('Fortnite');

      const partnerships = dto.jobs.find((j) => j.id === 'epicgames-5700006004');
      expect(partnerships).toBeDefined();
      // D-10 application lock for the second listing: the wire title
      // `'Partnerships Director - Sports & Talent '` carries a
      // trailing ASCII-space pad byte; the plugin applies `.trim()`
      // before emit. The emitted `title` is the trimmed form
      // `'Partnerships Director - Sports & Talent'` (no trailing
      // space) AND is byte-distinct from the wire-padded form.
      expect(partnerships?.title).toBe('Partnerships Director - Sports & Talent');
      expect(partnerships?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(partnerships?.title.length).toBe(
        JOBS_PAGE_RAW.jobs[1].title.length - 1,
      );
      expect(partnerships?.companyName).toBe('Epic Games');
      expect(partnerships?.location?.city).toBe('Cary,North Carolina,United States');
      expect(partnerships?.isRemote).toBe(false);
      // D-11 second-listing regression guard: the emitted `department`
      // for the second fixture listing matches the wire
      // `departments[0].name === 'Partnerships'` byte-for-byte (clean
      // single-token form; pass-through preserves byte-fidelity).
      expect(partnerships?.department).toBe('Partnerships');
      expect(partnerships?.department).toBe(
        JOBS_PAGE_RAW.jobs[1].departments[0].name,
      );
      // Variant-13 lock for the second listing too.
      expect(partnerships?.jobUrl).toBe(
        'https://epicgames.com/careers/jobs/5700006004?gh_jid=5700006004',
      );
      expect(partnerships?.jobUrl).toContain('epicgames.com/careers/jobs/');
      // Tags stripped after decode (no literal `<p>` substrings).
      expect(partnerships?.description).not.toContain('<p>');
      expect(partnerships?.description).not.toContain('<h2>');
      expect(partnerships?.description).toContain('Partnerships Director');
      expect(partnerships?.description).toContain('Fortnite');

      // Regression guard: the slug must be `epicgames` exactly.
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/epicgames/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EpicgamesService();
      const input: ScraperInputDto = {
        siteType: [Site.EPICGAMES],
        resultsWanted: 1,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EpicgamesService();
      const result = await service.scrape({
        siteType: [Site.EPICGAMES],
        searchTerm: 'CONCEPT',
      } as ScraperInputDto);

      // Only the first fixture job has 'Concept' in its title
      // ('Concept Outsource Lead'); the case-insensitive match on the
      // literal 'CONCEPT' substring matches it. The second listing's
      // title ('Partnerships Director - Sports & Talent') and
      // department ('Partnerships') do not contain 'concept', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('epicgames-5711341004');
      expect(result.jobs[0].title).toBe('Concept Outsource Lead');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new EpicgamesService();
      const result = await service.scrape({
        siteType: [Site.EPICGAMES],
        searchTerm: 'partnerships',
      } as ScraperInputDto);

      // The second fixture job has 'Partnerships' as both its title
      // ('Partnerships Director - Sports & Talent') and its
      // department ('Partnerships'); the case-insensitive match on
      // the literal 'partnerships' substring matches it. The first
      // listing's title ('Concept Outsource Lead') and dept ('Art')
      // do not contain 'partnerships', so it filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('epicgames-5700006004');
      expect(result.jobs[0].department).toBe('Partnerships');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new EpicgamesService();
      const result = await service.scrape({
        siteType: [Site.EPICGAMES],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new EpicgamesService();
      const result = await service.scrape({
        siteType: [Site.EPICGAMES],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
