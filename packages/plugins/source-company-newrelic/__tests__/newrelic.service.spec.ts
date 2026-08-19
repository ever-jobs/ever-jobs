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

import { NewRelicModule, NewRelicService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'newrelic-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 085 / T04 — `NewRelicService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `NewRelicService` through `NewRelicModule`.
 *   2. `Site.NEWRELIC === 'newrelic'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-2 URL,
 *      decode-then-strip pipeline cleanliness, internal-
 *      whitespace-asymmetric wire `companyName === 'New Relic'`,
 *      **D-10 application lock with BOTH-LEADING-AND-TRAILING-
 *      padded title form** — emitted `title` for the dual-padded
 *      listing equals trimmed form `'Account Executive -
 *      Commercial'` AND byte-distinct from wire `' Account
 *      Executive - Commercial '` (with leading AND trailing pad
 *      bytes) AND exactly **2 bytes shorter** (locking the both-
 *      side-pad observable, **first cohort observation of dual-
 *      pad on the title axis**).
 *   4. `resultsWanted = 1` against a two-listing fixture caps response.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department (case-insensitive).
 *   7. HTTP 500 → `{ jobs: [] }`.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('NewRelicService — Spec 085 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through NewRelicModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [NewRelicModule],
      }).compile();
      const service = moduleRef.get(NewRelicService);
      expect(service).toBeInstanceOf(NewRelicService);
      await moduleRef.close();
    });

    it('exports the Site.NEWRELIC = "newrelic" enum value', () => {
      expect(Site.NEWRELIC).toBe('newrelic');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      // First listing: clean wire title (D-10 trim no-op).
      const ae1 = dto.jobs.find((j) => j.id === 'newrelic-5202780008');
      expect(ae1).toBeDefined();
      expect(ae1?.site).toBe(Site.NEWRELIC);
      // D-09 omission lock with internal-whitespace-asymmetric
      // wire variant: emitted `companyName === 'New Relic'` byte-
      // for-byte AND byte-distinct from slug `newrelic` AND
      // exactly 1 byte longer than the slug AND case-
      // insensitively-with-space-collapsed-equal to the slug.
      // Same shape as Maven Clinic / Stitch Fix / Scale AI —
      // ninth slug/wire asymmetry case overall, fourth internal-
      // whitespace asymmetry case.
      expect(ae1?.companyName).toBe('New Relic');
      expect(ae1?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(ae1?.companyName).not.toBe('newrelic');
      expect(ae1?.companyName!.length).toBe('newrelic'.length + 1);
      expect(ae1?.companyName?.toLowerCase().replace(/\s+/g, '')).toBe('newrelic');
      // First-listing title is wire-clean — D-10 trim is a no-op.
      expect(ae1?.title).toBe(
        'Account Executive - Commercial - Fixed Term Contract (Maternity)',
      );
      expect(ae1?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant 2.
      expect(ae1?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/newrelic/jobs/5202780008',
      );
      expect(ae1?.jobUrl).toContain('job-boards.greenhouse.io/newrelic/jobs/');
      expect(ae1?.jobUrl).not.toContain('?gh_jid=');
      // First-listing department clean — D-11 omitted.
      expect(ae1?.department).toBe('Commercial');
      expect(ae1?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      expect(ae1?.location?.city).toBe('Remote, EU');
      expect(ae1?.isRemote).toBe(true);
      // D-08 regression guard.
      expect(ae1?.description).not.toContain('&lt;');
      expect(ae1?.description).not.toContain('&quot;');
      expect(ae1?.description).not.toContain('&amp;');
      expect(ae1?.description).not.toContain('<p>');
      expect(ae1?.description).not.toContain('<strong>');
      expect(ae1?.description).toContain('New Relic');
      expect(ae1?.description).toContain('observability');

      // Second listing: BOTH-LEADING-AND-TRAILING-padded wire
      // title — first cohort observation of dual-pad on the
      // title axis.
      const ae2 = dto.jobs.find((j) => j.id === 'newrelic-5202777008');
      expect(ae2).toBeDefined();
      // **D-10 application lock with BOTH-LEADING-AND-TRAILING-
      // padded form (FIRST cohort observation of dual-pad on the
      // title axis)**: emitted `title` for the second listing
      // equals the trimmed form `'Account Executive - Commercial'`
      // (no pad bytes on either side) AND byte-distinct from the
      // wire form `' Account Executive - Commercial '` (with
      // leading AND trailing pad bytes) AND is exactly **2 bytes
      // shorter** (1 byte for the leading pad + 1 byte for the
      // trailing pad). Twenty-first cohort plugin to apply D-10.
      expect(ae2?.title).toBe('Account Executive - Commercial');
      expect(ae2?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' Account Executive - Commercial ');
      expect(JOBS_PAGE_RAW.jobs[1].title.startsWith(' ')).toBe(true);
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(ae2?.title.startsWith(' ')).toBe(false);
      expect(ae2?.title.endsWith(' ')).toBe(false);
      expect(ae2?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 2);
      expect(ae2?.companyName).toBe('New Relic');
      expect(ae2?.location?.city).toBe('San Francisco, CA');
      expect(ae2?.isRemote).toBe(false);
      expect(ae2?.department).toBe('Enterprise');
      expect(ae2?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(ae2?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/newrelic/jobs/5202777008',
      );
      expect(ae2?.description).not.toContain('<p>');
      expect(ae2?.description).toContain('New Relic One');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/newrelic/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard for dual-pad)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
        searchTerm: 'MATERNITY',
      } as ScraperInputDto);

      // 'Maternity' appears only in the first listing's title.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('newrelic-5202780008');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
        searchTerm: 'enterprise',
      } as ScraperInputDto);

      // Only the second listing has 'Enterprise' as its dept.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('newrelic-5202777008');
      expect(result.jobs[0].department).toBe('Enterprise');
      // D-10 application lock — emitted title is trimmed form.
      expect(result.jobs[0].title).toBe('Account Executive - Commercial');
      expect(result.jobs[0].title.startsWith(' ')).toBe(false);
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new NewRelicService();
      const result = await service.scrape({
        siteType: [Site.NEWRELIC],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
