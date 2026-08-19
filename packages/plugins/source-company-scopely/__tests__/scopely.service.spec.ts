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

import { ScopelyModule, ScopelyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'scopely-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 087 / T04 — `ScopelyService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ScopelyService` through `ScopelyModule`.
 *   2. `Site.SCOPELY === 'scopely'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-2 URL byte-for-
 *      byte pass-through, decode-then-strip pipeline cleanliness,
 *      case-symmetric bare-brand wire `companyName === 'Scopely'`
 *      (D-09 omission lock; wire and slug both 7 bytes), **D-10
 *      application lock with single-trailing-padded form** —
 *      emitted `title` for the padded listing equals trimmed form
 *      `'Accounting Specialist'` AND byte-distinct from wire
 *      `'Accounting Specialist '` (with trailing pad byte) AND
 *      exactly 1 byte shorter (locking the trailing-pad
 *      observable).
 *   4. `resultsWanted = 1` against a two-listing fixture caps the response to one.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('ScopelyService — Spec 087 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ScopelyModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ScopelyModule],
      }).compile();
      const service = moduleRef.get(ScopelyService);
      expect(service).toBeInstanceOf(ScopelyService);
      await moduleRef.close();
    });

    it('exports the Site.SCOPELY = "scopely" enum value', () => {
      expect(Site.SCOPELY).toBe('scopely');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScopelyService();
      const input: ScraperInputDto = {
        siteType: [Site.SCOPELY],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const artist = dto.jobs.find((j) => j.id === 'scopely-5182665008');
      expect(artist).toBeDefined();
      expect(artist?.site).toBe(Site.SCOPELY);
      // D-09 omission lock: case-symmetric wire `'Scopely'`.
      expect(artist?.companyName).toBe('Scopely');
      expect(artist?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(artist?.companyName?.toLowerCase()).toBe('scopely');
      // First-listing title clean — D-10 trim no-op.
      expect(artist?.title).toBe('2D Artist - Monopoly GO!');
      expect(artist?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant 2 (canonical Greenhouse host).
      expect(artist?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/scopely/jobs/5182665008',
      );
      expect(artist?.jobUrl).toContain('job-boards.greenhouse.io/scopely/jobs/');
      expect(artist?.jobUrl).not.toContain('?gh_jid=');
      // D-11 first-listing pass-through guard — Scopely emits
      // operating-division banners under `departments[0].name`
      // (`'MonopolyGo'`, `'Niantic'`, `'Playgami'`) reflecting the
      // post-acquisition structure.
      expect(artist?.department).toBe('MonopolyGo');
      expect(artist?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // Location — Scopely's Barcelona studio.
      expect(artist?.location?.city).toBe('Barcelona, Spain');
      expect(artist?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(artist?.description).not.toContain('&lt;');
      expect(artist?.description).not.toContain('&quot;');
      expect(artist?.description).not.toContain('&amp;');
      expect(artist?.description).not.toContain('<p>');
      expect(artist?.description).not.toContain('<strong>');
      expect(artist?.description).toContain('Scopely');
      expect(artist?.description).toContain('Monopoly GO');

      const accounting = dto.jobs.find((j) => j.id === 'scopely-5198874002');
      expect(accounting).toBeDefined();
      // D-10 application lock — single-trailing-pad form: emitted
      // `title` is the trimmed `'Accounting Specialist'` (no
      // trailing pad bytes) AND byte-distinct from the wire form
      // `'Accounting Specialist '` AND exactly 1 byte shorter.
      // Twenty-third cohort plugin to apply D-10.
      expect(accounting?.title).toBe('Accounting Specialist');
      expect(accounting?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Accounting Specialist ');
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(accounting?.title.endsWith(' ')).toBe(false);
      expect(accounting?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(accounting?.companyName).toBe('Scopely');
      // D-11 second-listing pass-through guard.
      expect(accounting?.department).toBe('Finance');
      expect(accounting?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(accounting?.location?.city).toBe('Remote, USA');
      expect(accounting?.isRemote).toBe(true);
      // Variant-2 lock for second listing.
      expect(accounting?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/scopely/jobs/5198874002',
      );
      expect(accounting?.description).not.toContain('<p>');
      expect(accounting?.description).toContain('Scopely');
      expect(accounting?.description).toContain('mobile-games');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/scopely/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScopelyService();
      const result = await service.scrape({
        siteType: [Site.SCOPELY],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScopelyService();
      const result = await service.scrape({
        siteType: [Site.SCOPELY],
        searchTerm: 'ACCOUNTING',
      } as ScraperInputDto);

      // The search term `'ACCOUNTING'` matches the second listing's
      // trimmed title `'Accounting Specialist'`. The first listing
      // ('2D Artist - Monopoly GO!' / 'MonopolyGo') does not, so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('scopely-5198874002');
      // Lock D-10 application: emitted title is the trimmed form.
      expect(result.jobs[0].title).toBe('Accounting Specialist');
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ScopelyService();
      const result = await service.scrape({
        siteType: [Site.SCOPELY],
        searchTerm: 'monopoly',
      } as ScraperInputDto);

      // Only the first listing has 'MonopolyGo' as its department
      // AND the title contains 'Monopoly GO!'; the second listing
      // ('Accounting Specialist' / 'Finance') does not match.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('scopely-5182665008');
      expect(result.jobs[0].department).toBe('MonopolyGo');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ScopelyService();
      const result = await service.scrape({
        siteType: [Site.SCOPELY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ScopelyService();
      const result = await service.scrape({
        siteType: [Site.SCOPELY],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
