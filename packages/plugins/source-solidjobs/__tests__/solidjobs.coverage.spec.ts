import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import {
  CompensationInterval,
  Country,
  DatePostedPrecision,
  JobPostDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((..._args: unknown[]) => ({
  get: mockGet,
  setHeaders: mockSetHeaders,
}));
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args),
  };
});

import { SolidJobsService } from '../src/solidjobs.service';
import {
  SOLIDJOBS_DIVISIONS_ALL,
  SOLIDJOBS_MAX_PAGES_PER_DIVISION,
  SOLIDJOBS_USER_AGENT,
} from '../src/solidjobs.constants';

const API = 'https://solid.jobs/public-api/offers';
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const IT_PAGE0 = load('solidjobs-it-page0.json');
const IT_PAGE1 = load('solidjobs-it-page1.json');
const SALES_PAGE0 = load('solidjobs-sales-page0.json');
const LEGACY_PAGE = load('solidjobs-jobs.json');

const KEY = {
  react: 'solidjobs-0b8f5d3e-1a11-4c7a-9e01-000000000001',
  java: 'solidjobs-0b8f5d3e-1a11-4c7a-9e01-000000000002',
  lodz: 'solidjobs-0b8f5d3e-1a11-4c7a-9e01-000000000003',
  sales: 'solidjobs-0b8f5d3e-1a11-4c7a-9e01-000000000004',
};

const ENV_KEYS = [
  'SOLIDJOBS_DIVISIONS',
  'SOLIDJOBS_PAGINATE',
  'SOLIDJOBS_SEARCH_MODE',
  'SOLIDJOBS_INPUT_FILTERS',
  'SOLIDJOBS_TIME_BUDGET_MS',
  'EVER_JOBS_POSTED_TIME_DETAIL',
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Route = unknown | Error | (() => Promise<unknown>);

/** Parse a requested URL into its division and page index (`-` when un-paged). */
function routeKey(url: string): string {
  const parsed = new URL(url);
  const division = parsed.pathname.split('/').pop();
  return `${division}:${parsed.searchParams.get('pageIndex') ?? '-'}`;
}

/**
 * Route `division:pageIndex` to a page, an Error (rejected) or a function
 * returning the full response. Unrouted URLs answer an empty page, so no
 * test depends on call order under concurrency.
 */
function routeGet(routes: Record<string, Route>): void {
  mockGet.mockImplementation(async (url: string) => {
    const hit = routes[routeKey(url)];
    if (hit === undefined) return { data: { jobs: [], totalCount: 0, totalPages: 0 } };
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'function') return (hit as () => Promise<unknown>)();
    return { data: clone(hit) };
  });
}

/** The three synthetic pages of the fixture board. */
function routeBoard(extra: Record<string, Route> = {}): void {
  routeGet({ 'it:0': IT_PAGE0, 'it:1': IT_PAGE1, 'sales:0': SALES_PAGE0, ...extra });
}

const called = (): string[] => mockGet.mock.calls.map((c) => String(c[0]));
const calledKeys = (): string[] => called().map(routeKey);

function scrape(partial: Partial<ScraperInputDto> = {}) {
  return new SolidJobsService().scrape(
    new ScraperInputDto({ siteType: [Site.SOLIDJOBS], ...partial }),
  );
}

const ids = (jobs: JobPostDto[]): string[] => jobs.map((j) => j.id as string);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spec 1709 — Solid.Jobs full coverage: paging, every division, client-side
 * filters, full field mapping and honest diagnostics. Fixtures are synthetic
 * and follow the live wire shapes of 2026-09-24.
 */
describe('SolidJobsService — Spec 1709 full coverage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockReset();
    mockCreateHttpClient.mockImplementation(() => ({ get: mockGet, setHeaders: mockSetHeaders }));
    routeGet({});
    for (const key of ENV_KEYS) delete process.env[key];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('paging', () => {
    it('pages a division to its totalPages with the largest page when a filter is active', async () => {
      routeBoard();
      const result = await scrape({ searchTerm: 'developer' });

      expect(called()).toContain(`${API}/it?campaign=api&pageSize=500&pageIndex=0`);
      expect(called()).toContain(`${API}/it?campaign=api&pageSize=500&pageIndex=1`);
      expect(calledKeys()).not.toContain('it:2');
      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java]);
    });

    it('stops after one request when the first page fills an unfiltered request', async () => {
      routeBoard();
      const result = await scrape({ resultsWanted: 2 });

      expect(called()).toEqual([`${API}/it?campaign=api&pageSize=2&pageIndex=0`]);
      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java]);
    });

    it('fetches a page without an envelope once when it is shorter than pageSize', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      routeGet({ 'it:0': LEGACY_PAGE });
      const result = await scrape({ resultsWanted: 10 });

      expect(called()).toEqual([`${API}/it?campaign=api&pageSize=10&pageIndex=0`]);
      expect(result.jobs).toHaveLength(3);
    });

    it('stops when the server ignores pageIndex, without duplicates', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      const page = { ...clone(IT_PAGE0), totalPages: 5 };
      mockGet.mockImplementation(async () => ({ data: clone(page) }));

      const result = await scrape({ searchTerm: 'acme' });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java]);
    });

    it(`caps a division at ${SOLIDJOBS_MAX_PAGES_PER_DIVISION} pages`, async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      mockGet.mockImplementation(async (url: string) => {
        const pageIndex = new URL(url).searchParams.get('pageIndex');
        const page = clone(IT_PAGE0);
        page.jobs.forEach((job: any, i: number) => (job.jobOfferKey = `k-${pageIndex}-${i}`));
        return { data: { ...page, pageIndex: Number(pageIndex), totalPages: 999 } };
      });

      const result = await scrape({ searchTerm: 'zzz' });

      expect(mockGet).toHaveBeenCalledTimes(SOLIDJOBS_MAX_PAGES_PER_DIVISION);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeUndefined();
    });

    it('SOLIDJOBS_PAGINATE=false restores one un-paged request per division', async () => {
      process.env.SOLIDJOBS_PAGINATE = 'false';
      process.env.SOLIDJOBS_DIVISIONS = 'it,sales';
      routeGet({ 'it:-': LEGACY_PAGE });

      const result = await scrape({ resultsWanted: 100 });

      expect(called()).toEqual([`${API}/it?campaign=api`, `${API}/sales?campaign=api`]);
      expect(result.jobs).toHaveLength(3);
    });
  });

  describe('divisions', () => {
    it('scans all eight divisions and merges in division order, not completion order', async () => {
      routeBoard({
        'it:1': async () => {
          await delay(30);
          return { data: clone(IT_PAGE1) };
        },
      });

      const result = await scrape({ resultsWanted: 100 });

      const divisions = new Set(calledKeys().map((k) => k.split(':')[0]));
      expect([...divisions].sort()).toEqual([...SOLIDJOBS_DIVISIONS_ALL].sort());
      expect(calledKeys()[0]).toBe('it:0');
      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java, KEY.lodz, KEY.sales]);
    });

    it('moves the divisions a search term hints at to the front', async () => {
      await scrape({ searchTerm: 'handlowiec' });
      expect(calledKeys()[0]).toBe('sales:0');
      expect(calledKeys()[1]).toBe('it:0');
    });

    it('keeps the SOLIDJOBS_DIVISIONS order and ignores hints', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'hr, IT, hr';
      await scrape({ searchTerm: 'handlowiec' });
      expect(calledKeys()).toEqual(['hr:0', 'it:0']);
    });

    it('never has more than two requests in flight', async () => {
      let inFlight = 0;
      let peak = 0;
      mockGet.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await delay(5);
        inFlight--;
        return { data: { jobs: [], totalCount: 0, totalPages: 0 } };
      });

      await scrape({ searchTerm: 'zzz' });

      expect(mockGet).toHaveBeenCalledTimes(8);
      expect(peak).toBe(2);
    });
  });

  describe('searchTerm (tokens, diacritic-insensitive)', () => {
    beforeEach(() => routeBoard());

    it.each([
      ['react typescript', [KEY.react]],
      ['java senior', []],
      ['sprzedaz', [KEY.sales]],
      ['b2b sales', [KEY.sales]],
      ['acme software', [KEY.react, KEY.java]],
      ['automation', [KEY.lodz]],
      ['zzz', []],
    ])('"%s"', async (searchTerm, expected) => {
      const result = await scrape({ searchTerm: searchTerm as string });
      expect(ids(result.jobs)).toEqual(expected);
    });

    it('matches "java senior" through the experience level', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      routeGet({ 'it:0': LEGACY_PAGE });
      const result = await scrape({ searchTerm: 'java senior' });
      expect(ids(result.jobs)).toEqual([`solidjobs-${LEGACY_PAGE.jobs[0].jobOfferKey}`]);
    });

    it('SOLIDJOBS_SEARCH_MODE=phrase restores the whole-phrase matcher', async () => {
      process.env.SOLIDJOBS_SEARCH_MODE = 'phrase';
      expect(ids((await scrape({ searchTerm: 'react typescript' })).jobs)).toEqual([]);
      expect(ids((await scrape({ searchTerm: 'TypeScript' })).jobs)).toEqual([KEY.react]);
      // The company was never part of the phrase matcher's haystack.
      expect(ids((await scrape({ searchTerm: 'acme' })).jobs)).toEqual([]);
    });
  });

  describe('location / isRemote / jobType filters', () => {
    beforeEach(() => routeBoard());

    it.each([
      ['Krakow', [KEY.sales]],
      ['Warsaw', [KEY.react, KEY.java]],
      ['Warszawa, Poland', [KEY.react, KEY.java]],
      ['lodz', [KEY.lodz]],
      ['Gdańsk', [KEY.java]],
      ['Poland', [KEY.react, KEY.java, KEY.lodz, KEY.sales]],
      ['remote', [KEY.java, KEY.sales]],
      ['Berlin, Germany', []],
    ])('location "%s"', async (location, expected) => {
      const result = await scrape({ location: location as string, resultsWanted: 100 });
      expect(ids(result.jobs)).toEqual(expected);
    });

    it('isRemote=true keeps only remote offers; the DTO default false does not filter', async () => {
      expect(ids((await scrape({ isRemote: true, resultsWanted: 100 })).jobs)).toEqual([
        KEY.java,
        KEY.sales,
      ]);
      expect((await scrape({ resultsWanted: 100 })).jobs).toHaveLength(4);
    });

    it.each([
      [JobType.PART_TIME, [KEY.lodz]],
      [JobType.FULL_TIME, [KEY.react, KEY.java, KEY.sales]],
      [JobType.CONTRACT, [KEY.java, KEY.lodz, KEY.sales]],
      [JobType.INTERNSHIP, [KEY.lodz]],
      [JobType.TEMPORARY, []],
    ])('jobType %s', async (jobType, expected) => {
      const result = await scrape({ jobType: jobType as JobType, resultsWanted: 100 });
      expect(ids(result.jobs)).toEqual(expected);
    });

    it('SOLIDJOBS_INPUT_FILTERS=false ignores location, isRemote, jobType and hoursOld again', async () => {
      process.env.SOLIDJOBS_INPUT_FILTERS = 'off';
      const result = await scrape({
        location: 'Berlin',
        isRemote: true,
        jobType: JobType.TEMPORARY,
        hoursOld: 1,
        resultsWanted: 100,
      });
      expect(result.jobs).toHaveLength(4);
      // No filter left, so pages are sized to the request.
      expect(called()[0]).toBe(`${API}/it?campaign=api&pageSize=100&pageIndex=0`);
    });
  });

  describe('hoursOld', () => {
    it('drops older offers and stops paging after a page wholly outside the window', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-24T18:00:00+02:00'));
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      routeGet({
        'it:0': { ...clone(IT_PAGE0), totalPages: 5 },
        'it:1': { ...clone(IT_PAGE1), totalPages: 5 },
        'it:2': { ...clone(SALES_PAGE0), totalPages: 5 },
      });

      const result = await scrape({ hoursOld: 24 });

      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java]);
      expect(calledKeys()).toEqual(['it:0', 'it:1']);
    });
  });

  describe('offset', () => {
    it('returns the second match in division order', async () => {
      routeBoard();
      const result = await scrape({ offset: 1, resultsWanted: 1 });
      expect(called()).toEqual([`${API}/it?campaign=api&pageSize=2&pageIndex=0`]);
      expect(ids(result.jobs)).toEqual([KEY.java]);
    });

    it('applies after filtering', async () => {
      routeBoard();
      const result = await scrape({ isRemote: true, offset: 1, resultsWanted: 5 });
      expect(ids(result.jobs)).toEqual([KEY.sales]);
    });
  });

  describe('mapping', () => {
    let byId: Map<string, JobPostDto>;

    beforeEach(async () => {
      routeBoard();
      const result = await scrape({ resultsWanted: 100 });
      byId = new Map(result.jobs.map((j) => [j.id as string, j]));
      expect(byId.size).toBe(4);
    });

    it('keeps the source calendar day for datePosted and adds the exact instant', () => {
      const java = byId.get(KEY.java)!;
      expect(java.datePosted).toBe('2026-09-24');
      expect(java.datePostedAt).toBe('2026-09-23T22:30:00.123Z');
      expect(java.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
      expect(byId.get(KEY.react)!.datePosted).toBe('2026-09-24');
      expect(byId.get(KEY.sales)!.datePosted).toBe('2026-09-23');
    });

    it('maps the logo only when it is an absolute http(s) URL', () => {
      expect(byId.get(KEY.react)!.companyLogo).toBe(IT_PAGE0.jobs[0].companyLogoUrl);
      expect(byId.get(KEY.java)!.companyLogo).toBeNull();
    });

    it('de-duplicates skills case-insensitively in wire order', () => {
      expect(byId.get(KEY.react)!.skills).toEqual(['React', 'TypeScript']);
    });

    it('maps jobLevel and a humanised jobFunction', () => {
      expect(byId.get(KEY.react)!.jobLevel).toBe('Senior');
      expect(byId.get(KEY.sales)!.jobFunction).toBe('B2B Sales');
      expect(byId.get(KEY.lodz)!.jobFunction).toBe('Tester');
    });

    it('derives workFromHomeType from the board flags', () => {
      expect(byId.get(KEY.react)!.workFromHomeType).toBe('Hybrid');
      expect(byId.get(KEY.java)!.workFromHomeType).toBe('Remote');
      expect(byId.get(KEY.sales)!.workFromHomeType).toBe('Hybrid or Remote');
      expect(byId.get(KEY.lodz)!.workFromHomeType).toBeNull();
    });

    it('joins the contract forms of both salaries into employmentType', () => {
      expect(byId.get(KEY.lodz)!.employmentType).toBe('UZ, B2B');
      expect(byId.get(KEY.react)!.employmentType).toBe('UoP');
      expect(byId.get(KEY.sales)!.employmentType).toBe('UoD');
    });

    it('falls back to the secondary salary for compensation', () => {
      const comp = byId.get(KEY.sales)!.compensation!;
      expect(comp.minAmount).toBe(5200);
      expect(comp.maxAmount).toBe(5500);
      expect(comp.currency).toBe('PLN');
      expect(comp.interval).toBe(CompensationInterval.MONTHLY);
    });

    it('sets the board-level country without touching the cities', () => {
      for (const job of byId.values()) {
        expect(job.countryCode).toBe('PL');
        expect(job.location?.country).toBe(Country.POLAND);
      }
      const java = byId.get(KEY.java)!;
      expect(java.locations?.map((l) => l.city)).toEqual(['Warszawa', 'Gdańsk']);
      expect(java.locations?.every((l) => l.country === Country.POLAND)).toBe(true);
      expect(byId.get(KEY.lodz)!.location?.city).toBe('Łódź');
    });

    it('keeps jobType from contractTime (never adds CONTRACT)', () => {
      expect(byId.get(KEY.lodz)!.jobType).toEqual([JobType.PART_TIME]);
      expect(byId.get(KEY.java)!.jobType).toEqual([JobType.FULL_TIME]);
    });
  });

  describe('mapping edge cases', () => {
    it('emits a country-only location when an offer has no place label', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      const page = clone(IT_PAGE0);
      page.jobs[0].locations = ['Cała Polska'];
      page.jobs[1].locations = undefined;
      routeGet({ 'it:0': page });

      const result = await scrape({ resultsWanted: 2 });

      for (const job of result.jobs) {
        expect(job.location?.country).toBe(Country.POLAND);
        expect(job.location?.city ?? null).toBeNull();
        expect(job.locations ?? undefined).toBeUndefined();
      }
    });

    it('EVER_JOBS_POSTED_TIME_DETAIL=false keeps datePosted only', async () => {
      process.env.EVER_JOBS_POSTED_TIME_DETAIL = 'false';
      routeBoard();
      const result = await scrape({ resultsWanted: 2 });
      expect(result.jobs[1].datePosted).toBe('2026-09-24');
      expect(result.jobs[1].datePostedAt).toBeUndefined();
    });

    it('skips an offer whose mapping throws and keeps its siblings', async () => {
      routeBoard();
      jest
        .spyOn(SolidJobsService.prototype as any, 'mapJob')
        .mockImplementationOnce(() => {
          throw new Error('boom');
        });
      const result = await scrape({ resultsWanted: 2 });
      expect(ids(result.jobs)).toEqual([KEY.java]);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
  });

  describe('diagnostics', () => {
    it('keeps page 0 and reports a failure on page 1', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      routeGet({ 'it:0': IT_PAGE0, 'it:1': new Error('Request failed with status 503') });

      const result = await scrape({ resultsWanted: 10 });

      expect(ids(result.jobs)).toEqual([KEY.react, KEY.java]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(result.diagnostics?.detail).toContain('failed divisions: it');
    });

    it('reports a timeout-classified failure when every request times out', async () => {
      mockGet.mockRejectedValue(new Error('timeout of 60000ms exceeded'));
      const result = await scrape();
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('timeout');
    });

    it('stays silent when a failed division did not stop the request being filled', async () => {
      process.env.SOLIDJOBS_DIVISIONS = 'sales,it';
      routeGet({ 'sales:0': new Error('Request failed with status 500'), 'it:0': IT_PAGE0 });

      const result = await scrape({ resultsWanted: 2 });

      expect(result.jobs).toHaveLength(2);
      expect(result.diagnostics).toBeUndefined();
    });

    it('returns partial with the budget detail when the time budget runs out', async () => {
      let now = Date.parse('2026-09-24T18:00:00+02:00');
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      routeGet({
        'it:0': async () => {
          now += 100_000;
          return { data: clone(IT_PAGE0) };
        },
      });

      const result = await scrape();

      expect(calledKeys()).toEqual(['it:0']);
      expect(result.jobs).toHaveLength(2);
      expect(result.diagnostics?.reason).toBe('partial');
      expect(result.diagnostics?.detail).toBe(
        'time budget 90000 ms reached; scanned 1/8 divisions',
      );
    });

    it('returns timeout when the budget runs out before any match, and honours SOLIDJOBS_TIME_BUDGET_MS', async () => {
      process.env.SOLIDJOBS_TIME_BUDGET_MS = '5000';
      process.env.SOLIDJOBS_DIVISIONS = 'it';
      let now = Date.parse('2026-09-24T18:00:00+02:00');
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      routeGet({
        'it:0': async () => {
          now += 6_000;
          return { data: clone(IT_PAGE0) };
        },
      });

      const result = await scrape({ searchTerm: 'zzz' });

      expect(calledKeys()).toEqual(['it:0']);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('timeout');
      expect(result.diagnostics?.detail).toContain('time budget 5000 ms');
    });
  });

  describe('HTTP client', () => {
    it('sends the honest User-Agent by default and never pins one in the headers', async () => {
      await scrape({ resultsWanted: 1 });
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: SOLIDJOBS_USER_AGENT }),
      );
      const headers = mockSetHeaders.mock.calls[0][0] as Record<string, string>;
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
      expect(headers.Accept).toBe('application/json');
    });

    it('honours input.userAgent and passes the retry and rate options through', async () => {
      await scrape({
        resultsWanted: 1,
        userAgent: 'CustomAgent/2.0',
        retries: 1,
        retryDelay: 250,
        rateDelayMin: 1,
        rateDelayMax: 2,
        requestTimeout: 30,
      });
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'CustomAgent/2.0',
          retries: 1,
          retryDelay: 250,
          rateDelayMin: 1,
          rateDelayMax: 2,
          timeout: 30,
        }),
      );
    });

    it('makes no request when resultsWanted is 0', async () => {
      const result = await scrape({ resultsWanted: 0 });
      expect(result.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
