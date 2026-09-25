import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  DescriptionFormat,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn();
const mockRandomSleep = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => {
      mockCreateHttpClient(...args);
      return { get: mockGet, setHeaders: mockSetHeaders };
    },
    randomSleep: (...args: unknown[]) => {
      mockRandomSleep(...args);
      return Promise.resolve();
    },
  };
});

import { BDJobsModule } from '../src/bdjobs.module';
import { BDJobsService } from '../src/bdjobs.service';
import {
  BDJOBS_DETAILS_URL,
  BDJOBS_LEGACY_SEARCH_URL,
  BDJOBS_MAX_PAGES,
  BDJOBS_SEARCH_URL,
} from '../src/bdjobs.constants';
import { BdjobsListItem } from '../src/bdjobs.types';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const PAGE1 = JSON.parse(read('bdjobs-search-page1.json'));
const PAGE2 = JSON.parse(read('bdjobs-search-page2.json'));
const EMPTY = JSON.parse(read('bdjobs-search-empty.json'));
const DETAILS = JSON.parse(read('bdjobs-details.json'));
const DETAILS_NOT_FOUND = JSON.parse(read('bdjobs-details-notfound.json'));
const SPA_SHELL = read('bdjobs-spa-shell.html');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An axios-style HTTP failure. */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

/** A details payload for any id, cloned from the fixture. */
function detailsFor(id: string): unknown {
  const body = clone(DETAILS);
  body.data[0].JobId = id;
  return body;
}

/** A synthetic list row. */
function makeItem(id: number, overrides: Partial<BdjobsListItem> = {}): BdjobsListItem {
  return {
    Jobid: String(id),
    AdType: '0',
    jobTitle: `Developer ${id}`,
    JobTitleBng: `Developer ${id}`,
    companyName: `Company ${id}`,
    deadline: 'Oct 30, 2026',
    publishDate: '2026-09-20T08:00:00Z',
    eduRec: '',
    experience: '1 to 3 years',
    location: 'Dhaka',
    jobContext: null,
    logoUrl: '',
    jobDescription: '',
    JobType: 'FullTime',
    Vacancies: 1,
    Salary: '--',
    WorkPlace: 'Office',
    ...overrides,
  };
}

/** A synthetic search page of consecutive ids. */
function makePage(firstId: number, count: number, totalpages: number): unknown {
  return {
    message: 'Success',
    statuscode: '1',
    data: Array.from({ length: count }, (_, i) => makeItem(firstId + i)),
    premiumData: [],
    common: { total_records_found: totalpages * 30, totalpages, showd: '1', total_vacancies: 0 },
  };
}

type Responder = unknown | Error | ((params: Record<string, any>) => unknown);

interface Routes {
  pages?: Record<number, Responder>;
  /** Fallback for any page not listed. */
  anyPage?: Responder;
  details?: Record<string, Responder>;
  /** Fallback for any id not listed (default: the fixture with that id). */
  anyDetails?: Responder;
}

function respond(responder: Responder, params: Record<string, any>): unknown {
  const value = typeof responder === 'function' ? (responder as (p: Record<string, any>) => unknown)(params) : responder;
  if (value instanceof Error) throw value;
  return { status: 200, data: typeof value === 'string' ? value : clone(value) };
}

function route(routes: Routes): void {
  mockGet.mockImplementation(async (url: string, config: { params: Record<string, any> }) => {
    const params = config?.params ?? {};
    if (url === BDJOBS_SEARCH_URL) {
      const responder = routes.pages?.[params.pg] ?? routes.anyPage ?? EMPTY;
      return respond(responder, params);
    }
    if (url === BDJOBS_DETAILS_URL) {
      const id = String(params.jobId);
      const responder = routes.details?.[id] ?? routes.anyDetails ?? (() => detailsFor(id));
      return respond(responder, params);
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

const searchCalls = () => mockGet.mock.calls.filter(([url]) => url === BDJOBS_SEARCH_URL);
const detailCalls = () => mockGet.mock.calls.filter(([url]) => url === BDJOBS_DETAILS_URL);
const detailIds = () => detailCalls().map(([, config]) => String(config.params.jobId));

function input(partial: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ siteType: [Site.BDJOBS], searchTerm: 'developer', ...partial });
}

async function scrape(partial: Partial<ScraperInputDto> = {}): Promise<JobResponseDto> {
  return new BDJobsService().scrape(input(partial));
}

/** Spec 1711 — BDJobsService on the public JSON API. */
describe('BDJobsService — Spec 1711', () => {
  const savedEnv = { mode: process.env.BDJOBS_MODE, strategy: process.env.BDJOBS_STRATEGY };

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockReset();
    mockRandomSleep.mockReset();
    delete process.env.BDJOBS_MODE;
    delete process.env.BDJOBS_STRATEGY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (savedEnv.mode === undefined) delete process.env.BDJOBS_MODE;
    else process.env.BDJOBS_MODE = savedEnv.mode;
    if (savedEnv.strategy === undefined) delete process.env.BDJOBS_STRATEGY;
    else process.env.BDJOBS_STRATEGY = savedEnv.strategy;
  });

  describe('registration', () => {
    it('resolves through BDJobsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [BDJobsModule] }).compile();
      expect(moduleRef.get(BDJobsService)).toBeInstanceOf(BDJobsService);
      await moduleRef.close();
    });
  });

  describe('field mapping', () => {
    it('maps job 1536338 from list + details', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ resultsWanted: 100 });
      const job = res.jobs.find((j) => j.id === '1536338')!;

      expect(job).toMatchObject({
        id: '1536338',
        site: Site.BDJOBS,
        title: '.NET Developer',
        companyName: 'Careberry Software Ltd',
        jobUrl: 'https://bdjobs.com/h/details/1536338',
        datePosted: '2026-09-23',
        jobType: [JobType.CONTRACT],
        isRemote: true,
        workFromHomeType: 'Remote',
        countryCode: 'BD',
        experienceRange: 'At least 4 years',
        skills: ['ASP.NET MVC', 'Microsoft Azure', 'JavaScript ES6', 'TypeScript'],
        vacancyCount: null,
      });
      expect(job.compensation).toMatchObject({ currency: 'BDT', interval: 'monthly', minAmount: 90000, maxAmount: 140000 });
      expect(job.location).toMatchObject({ country: 'Bangladesh', text: 'Anywhere in Bangladesh' });
      expect(job.location?.city).toBeUndefined();
      expect(job.description).toContain('Key Responsibilities');
      expect(job.description).toContain('Deadline: Oct 11, 2026');
      expect(job.description).not.toMatch(/<[a-z]/i);
      expect(JSON.stringify(res)).not.toContain('0.0.0.0');
    });

    it('regression: the deadline is never the posting date', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ resultsWanted: 100, descriptionDepth: 'board' });
      const rows = [...PAGE1.data, ...PAGE2.data] as BdjobsListItem[];
      for (const job of res.jobs) {
        const row = rows.find((r) => r.Jobid === job.id)!;
        expect(job.datePosted).toBe(row.publishDate!.slice(0, 10));
      }
      expect(res.jobs.find((j) => j.id === '1536338')!.datePosted).not.toBe('2026-10-11');
    });

    it('falls back to the details PostedOn when the list has no publish date', async () => {
      const page = clone(PAGE1);
      page.data[1].publishDate = null;
      route({ pages: { 1: page } });
      const res = await scrape({ resultsWanted: 3 });
      expect(res.jobs.find((j) => j.id === '1536338')!.datePosted).toBe('2026-09-23');
    });
  });

  describe('dedupe and pagination', () => {
    it('regression: dedupes premium/data overlap and repeats before any details call', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ resultsWanted: 100, descriptionDepth: 'detail-all' });

      const ids = res.jobs.map((j) => j.id);
      expect(ids).toEqual(['1535768', '1537681', '1536338', '1529696', '1529470', '1532328', '1534263', '1527718']);
      expect(new Set(detailIds()).size).toBe(detailIds().length);
      expect(detailIds().sort()).toEqual([...ids].sort());
      expect(res.jobs[0].listingType).toBe('premium');
      expect(res.diagnostics).toBeUndefined();
    });

    it('stops at totalpages', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 }, anyPage: new Error('page beyond totalpages requested') });
      await scrape({ resultsWanted: 100, descriptionDepth: 'board' });
      expect(searchCalls().map(([, c]) => c.params.pg)).toEqual([1, 2]);
    });

    it('stops when a page adds no new ids (a server ignoring pg)', async () => {
      const looping = { ...clone(PAGE1), common: { ...PAGE1.common, totalpages: 999 } };
      route({ anyPage: looping });
      const res = await scrape({ resultsWanted: 1000, descriptionDepth: 'board' });
      expect(searchCalls()).toHaveLength(2);
      expect(res.jobs).toHaveLength(6);
      expect(res.diagnostics).toBeUndefined();
    });

    it('caps a 999-page board at BDJOBS_MAX_PAGES requests', async () => {
      route({ anyPage: (params: Record<string, any>) => makePage(100_000 + params.pg * 100, 30, 999) });
      const res = await scrape({ resultsWanted: 5000, descriptionDepth: 'board' });
      expect(searchCalls()).toHaveLength(BDJOBS_MAX_PAGES);
      expect(res.jobs).toHaveLength(BDJOBS_MAX_PAGES * 30);
    });

    it('fetches pages sequentially with a delay between them', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      route({
        anyPage: (params: Record<string, any>) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          inFlight--;
          return makePage(params.pg * 100, 30, 3);
        },
      });
      await scrape({ resultsWanted: 90, descriptionDepth: 'board' });
      expect(maxInFlight).toBe(1);
      expect(searchCalls()).toHaveLength(3);
      expect(mockRandomSleep).toHaveBeenCalledWith(2000, 4000);
    });

    it('only fetches the pages resultsWanted needs', async () => {
      route({ anyPage: (params: Record<string, any>) => makePage(params.pg * 100, 30, 10) });
      const res = await scrape({ resultsWanted: 2 });
      expect(searchCalls()).toHaveLength(1);
      expect(res.jobs).toHaveLength(2);
      expect(detailCalls()).toHaveLength(2);
    });
  });

  describe('input mapping', () => {
    it('offset 35 starts at pg=2 and skips 5 rows', async () => {
      route({ pages: { 2: makePage(2000, 30, 3), 3: makePage(3000, 30, 3) } });
      const res = await scrape({ offset: 35, resultsWanted: 3, descriptionDepth: 'board' });
      expect(searchCalls()[0][1].params.pg).toBe(2);
      expect(res.jobs.map((j) => j.id)).toEqual(['2005', '2006', '2007']);
    });

    it('trims the keyword and omits a blank one', async () => {
      route({ pages: { 1: EMPTY } });
      await scrape({ searchTerm: '  developer ' });
      expect(searchCalls()[0][1].params).toEqual({ keyword: 'developer', pg: 1, rpp: 30, isPro: 0 });

      mockGet.mockClear();
      await scrape({ searchTerm: '   ' });
      expect(searchCalls()[0][1].params).not.toHaveProperty('keyword');
    });

    it('isRemote sends workplace=1 and drops rows that are not home-based', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ isRemote: true, resultsWanted: 100, descriptionDepth: 'board' });
      expect(searchCalls()[0][1].params.workplace).toBe('1');
      expect(res.jobs.map((j) => j.id)).toEqual(['1536338', '1529696']);
      expect(res.jobs[1]).toMatchObject({ isRemote: false, workFromHomeType: 'Hybrid' });
    });

    it('does not send workplace when isRemote is false', async () => {
      route({ pages: { 1: EMPTY } });
      await scrape({ isRemote: false });
      expect(searchCalls()[0][1].params).not.toHaveProperty('workplace');
    });

    it('hoursOld drops old rows even when they come before newer ones', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-24T18:00:00Z'));
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ hoursOld: 48, resultsWanted: 100, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['1537681', '1536338']);
    });

    it('hoursOld keeps a row without a parseable publish date', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-24T18:00:00Z'));
      const page = clone(PAGE1);
      page.data[3].publishDate = 'Sep 1, 2026';
      page.premiumData = [];
      route({ pages: { 1: page } });
      const res = await scrape({ hoursOld: 1, resultsWanted: 100, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['1535768']);
    });

    it('jobType filters on the list job type and keeps unknown types', async () => {
      const page = clone(PAGE1);
      page.data[5].JobType = '';
      route({ pages: { 1: page, 2: PAGE2 } });
      const res = await scrape({ jobType: JobType.CONTRACT, resultsWanted: 100, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['1536338', '1532328', '1534263']);
    });

    it('ignores the default USA country: the board is Bangladesh-only', async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ resultsWanted: 3, descriptionDepth: 'board' });
      expect(res.jobs).toHaveLength(3);
    });
  });

  describe('descriptionDepth', () => {
    it("'board' makes no details calls and never uses the education snippet", async () => {
      route({ pages: { 1: PAGE1, 2: PAGE2 } });
      const res = await scrape({ resultsWanted: 100, descriptionDepth: 'board' });
      expect(detailCalls()).toHaveLength(0);
      expect(res.jobs.find((j) => j.id === '1537681')!.description).toContain('Competitive basic salary');
      expect(res.jobs.find((j) => j.id === '1536338')!.description).toBeNull();
      for (const job of res.jobs) {
        expect(job.description ?? '').not.toContain('Bachelor');
      }
    });

    it('defaults to at most 25 details calls, sequentially', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      route({
        pages: { 1: makePage(5000, 30, 1) },
        anyDetails: (params: Record<string, any>) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          inFlight--;
          return detailsFor(String(params.jobId));
        },
      });
      const res = await scrape({ resultsWanted: 30 });
      expect(res.jobs).toHaveLength(30);
      expect(detailCalls()).toHaveLength(25);
      expect(maxInFlight).toBe(1);
      expect(mockRandomSleep).toHaveBeenCalledWith(1000, 2000);
      expect(res.jobs[25].skills).toBeUndefined();
      expect(res.jobs[24].skills).toBeDefined();
    });

    it("'detail-all' enriches every kept job", async () => {
      route({ pages: { 1: makePage(5000, 30, 1) } });
      await scrape({ resultsWanted: 30, descriptionDepth: 'detail-all' });
      expect(detailCalls()).toHaveLength(30);
    });

    it('the time budget stops enrichment and every job is still returned', async () => {
      let clock = Date.parse('2026-09-24T18:00:00Z');
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      route({
        pages: { 1: PAGE1, 2: PAGE2 },
        anyDetails: (params: Record<string, any>) => {
          clock += 20_000;
          return detailsFor(String(params.jobId));
        },
      });
      const res = await scrape({ resultsWanted: 100 });
      expect(detailCalls()).toHaveLength(3);
      expect(res.jobs).toHaveLength(8);
      expect(res.diagnostics).toBeUndefined();
    });
  });

  describe('description formats', () => {
    const run = async (format: DescriptionFormat) => {
      route({ pages: { 1: PAGE1 } });
      const res = await scrape({ resultsWanted: 3, descriptionFormat: format });
      return res.jobs.find((j) => j.id === '1536338')!.description!;
    };

    it('HTML passes through with section headings and the deadline line', async () => {
      const html = await run(DescriptionFormat.HTML);
      expect(html).toContain('<h2>Key Responsibilities</h2>');
      expect(html).toContain('<h2>Experience</h2>');
      expect(html).toContain('<h2>Additional requirements</h2>');
      expect(html).toContain('<p>Deadline: Oct 11, 2026</p>');
    });

    it('MARKDOWN has no HTML tags', async () => {
      const md = await run(DescriptionFormat.MARKDOWN);
      expect(md).not.toMatch(/<[a-z]/i);
      expect(md).toMatch(/Experience/);
      expect(md).toContain('Deadline: Oct 11, 2026');
    });

    it('PLAIN has no HTML tags', async () => {
      const plain = await run(DescriptionFormat.PLAIN);
      expect(plain).not.toMatch(/<[a-z]/i);
      expect(plain).toContain('Additional requirements');
      expect(plain).toContain('Deadline: Oct 11, 2026');
    });
  });

  describe('details outcomes', () => {
    it('a not-found or closed job keeps its list fields, without a diagnostic', async () => {
      const closed = clone(DETAILS);
      closed.data[0].Closed = 1;
      route({ pages: { 1: PAGE1 }, details: { '1536338': DETAILS_NOT_FOUND, '1537681': closed } });
      const res = await scrape({ resultsWanted: 3 });
      expect(res.jobs.map((j) => j.id)).toEqual(['1535768', '1537681', '1536338']);
      const notFound = res.jobs.find((j) => j.id === '1536338')!;
      expect(notFound.skills).toBeUndefined();
      expect(notFound.description).toBeNull();
      expect(notFound.title).toBe('.NET Developer');
      expect(res.jobs.find((j) => j.id === '1537681')!.skills).toBeUndefined();
      expect(res.diagnostics).toBeUndefined();
    });

    it('merges ApplyEmail with the emails in the description, de-duplicated', async () => {
      const withEmail = clone(DETAILS);
      withEmail.data[0].ApplyEmail = 'hr@example.com';
      withEmail.data[0].JobDescription = '<p>Apply to HR@example.com or talent@example.com</p>';
      route({ pages: { 1: PAGE1 }, details: { '1536338': withEmail } });
      const res = await scrape({ resultsWanted: 3 });
      expect(res.jobs.find((j) => j.id === '1536338')!.emails).toEqual(['HR@example.com', 'talent@example.com']);
    });
  });

  describe('diagnostics', () => {
    it('page-1 403 → blocked, no jobs', async () => {
      route({ pages: { 1: httpError(403) } });
      const res = await scrape();
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('page-1 500 → fetch_error, no jobs', async () => {
      route({ pages: { 1: httpError(500) } });
      const res = await scrape();
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a page-2 failure returns page-1 jobs with a diagnostic, still enriched', async () => {
      route({ pages: { 1: PAGE1, 2: httpError(502) } });
      const res = await scrape({ resultsWanted: 100 });
      expect(res.jobs).toHaveLength(6);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(detailCalls()).toHaveLength(6);
    });

    it('regression: a 200 SPA shell is a diagnostic, not an empty board', async () => {
      route({ pages: { 1: SPA_SHELL } });
      const res = await scrape();
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toMatchObject({ reason: 'fetch_error', detail: 'unexpected non-JSON search response' });
    });

    it('a challenge page is blocked', async () => {
      route({ pages: { 1: '<html><head><title>Just a moment...</title></head></html>' } });
      const res = await scrape();
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('JSON without a data array is unknown', async () => {
      route({ pages: { 1: { message: 'Error', statuscode: '0' } } });
      const res = await scrape();
      expect(res.diagnostics?.reason).toBe('unknown');
      expect(res.diagnostics?.detail).toContain('message, statuscode');
    });

    it('a legitimately empty search has no diagnostic', async () => {
      route({ pages: { 1: EMPTY } });
      const res = await scrape();
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(searchCalls()).toHaveLength(1);
      expect(detailCalls()).toHaveLength(0);
    });

    it('all attempted details calls failing attaches a diagnostic; the jobs survive', async () => {
      route({ pages: { 1: PAGE1 }, anyDetails: httpError(500) });
      const res = await scrape({ resultsWanted: 2 });
      expect(res.jobs).toHaveLength(2);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('stops the details pass after three consecutive failures', async () => {
      route({ pages: { 1: PAGE1 }, anyDetails: httpError(500) });
      const res = await scrape({ resultsWanted: 6 });
      expect(detailCalls()).toHaveLength(3);
      expect(res.jobs).toHaveLength(6);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('one failed details call among successes attaches nothing', async () => {
      route({ pages: { 1: PAGE1 }, details: { '1537681': httpError(500) } });
      const res = await scrape({ resultsWanted: 3 });
      expect(res.jobs).toHaveLength(3);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a malformed details body counts as a failure', async () => {
      route({ pages: { 1: PAGE1 }, anyDetails: '<html>maintenance</html>' });
      const res = await scrape({ resultsWanted: 2 });
      expect(res.jobs).toHaveLength(2);
      expect(res.diagnostics?.reason).toBe('unknown');
    });

    it('a row that fails to map is skipped, the rest are kept', async () => {
      const page = clone(PAGE1);
      page.premiumData = [];
      page.data[0].jobTitle = '';
      page.data[0].JobTitleBng = '';
      route({ pages: { 1: page } });
      const res = await scrape({ resultsWanted: 100, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).not.toContain('1537681');
      expect(res.jobs).toHaveLength(5);
    });
  });

  describe('HTTP client', () => {
    it('sends honest JSON headers', async () => {
      route({ pages: { 1: EMPTY } });
      await scrape();
      const headers = mockSetHeaders.mock.calls[0][0];
      expect(headers['User-Agent']).toContain('EverJobs/1.0');
      expect(headers.Accept).toBe('application/json');
      expect(headers).not.toHaveProperty('Referer');
    });

    it('input.userAgent overrides the User-Agent', async () => {
      route({ pages: { 1: EMPTY } });
      await scrape({ userAgent: 'MyBot/2.0 (+https://example.com/bot)' });
      expect(mockSetHeaders.mock.calls[0][0]['User-Agent']).toBe('MyBot/2.0 (+https://example.com/bot)');
    });

    it('passes the timeout under both keys, the client options, and pins redirects', async () => {
      route({ pages: { 1: EMPTY } });
      await scrape({ requestTimeout: 12, proxies: ['http://proxy:8080'], retries: 1, rateDelayMin: 1, rateDelayMax: 2 });
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 12,
          requestTimeout: 12,
          proxies: ['http://proxy:8080'],
          retries: 1,
          rateDelayMin: 1,
          rateDelayMax: 2,
          allowedRedirectHosts: ['bdjobs.com'],
        }),
      );
    });
  });

  describe('strategy switch', () => {
    it('BDJOBS_MODE=html selects the legacy HTML page', async () => {
      process.env.BDJOBS_MODE = 'html';
      mockGet.mockResolvedValue({ status: 200, data: SPA_SHELL });
      const res = await scrape();
      expect(mockGet.mock.calls[0][0]).toBe(BDJOBS_LEGACY_SEARCH_URL);
      expect(searchCalls()).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('BDJOBS_STRATEGY=legacy-html is an alias when BDJOBS_MODE is unset', async () => {
      process.env.BDJOBS_STRATEGY = 'legacy-html';
      mockGet.mockResolvedValue({ status: 200, data: SPA_SHELL });
      await scrape();
      expect(mockGet.mock.calls[0][0]).toBe(BDJOBS_LEGACY_SEARCH_URL);
    });

    it('an unrecognised mode falls back to the API', async () => {
      process.env.BDJOBS_MODE = 'scrape';
      route({ pages: { 1: EMPTY } });
      await scrape();
      expect(searchCalls()).toHaveLength(1);
    });
  });
});
