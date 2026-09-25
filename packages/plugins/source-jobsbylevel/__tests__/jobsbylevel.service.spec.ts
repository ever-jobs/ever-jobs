import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import {
  CompensationInterval,
  Country,
  DescriptionFormat,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((_options?: unknown) => ({
  get: mockGet,
  post: mockPost,
  setHeaders: mockSetHeaders,
}));
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (options?: unknown) => mockCreateHttpClient(options),
  };
});

import { JobsByLevelModule, JobsByLevelService } from '@ever-jobs/source-jobsbylevel';
import {
  JOBSBYLEVEL_MCP_URL,
  JOBSBYLEVEL_SITE,
  JOBSBYLEVEL_USER_AGENT,
} from '../src/jobsbylevel.constants';
import { jobsByLevelRuntime, resetJobsByLevelState } from '../src/jobsbylevel.state';
import { JobsByLevelItem, JobsByLevelJobPost } from '../src/jobsbylevel.types';

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const SEARCH_PAGE = JSON.parse(readFixture('jobsbylevel-search-page.json'));
const GET_JOB = JSON.parse(readFixture('jobsbylevel-get-job.json'));
const FEED_XML = readFixture('jobsbylevel-feed.rss.xml');
const DETAIL_HTML = readFixture('jobsbylevel-detail.html');
const RPC_WIRE = JSON.parse(readFixture('jobsbylevel-mcp-search.rpc.json'));

const ENV_KEYS = [
  'JOBSBYLEVEL_TRANSPORT',
  'JOBSBYLEVEL_FEED_FALLBACK',
  'JOBSBYLEVEL_MIN_AI_LEVEL',
  'JOBSBYLEVEL_MAX_AI_LEVEL',
  'JOBSBYLEVEL_CATEGORIES',
  'JOBSBYLEVEL_MAX_PAGES',
  'JOBSBYLEVEL_CACHE_TTL_MS',
  'JOBSBYLEVEL_EMIT_AI_LEVEL',
];

const SLUG = {
  thinkingMachines: 'research-finetuning-science-at-thinking-machines-lab-dc9da3',
  snowflake: 'staff-research-scientist-physical-ai-multimodality-at-snowflake-d81471',
  faculty: 'senior-research-scientist-ai-safety-at-faculty-80ffaa',
  coinbase: 'compliance-international-investigations-associate-at-coinbase-c49003',
  exampleUs: 'machine-learning-engineer-at-example-analytics-a1b2c3',
  exampleUk: 'customer-success-manager-at-example-telecom-d4e5f6',
  exampleSponsored: 'data-analyst-at-example-retail-0f9e8d',
};

const NOW = Date.parse('2026-09-25T10:00:00.000Z');
let clock = NOW;
const originalRuntime = { ...jobsByLevelRuntime };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The wire shape of a `tools/call` result: the payload as JSON text content. */
function rpc(payload: unknown): { data: unknown } {
  return {
    data: {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    },
  };
}

function makeItem(i: number, overrides: Partial<JobsByLevelItem> = {}): JobsByLevelItem {
  const slug = `role-${i}-at-example-${String(i).padStart(6, '0')}`;
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    slug,
    title: `Role ${i}`,
    company: 'Example',
    company_slug: 'example',
    location: 'Berlin',
    remote: true,
    country: 'DE',
    employment_type: 'FullTime',
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    category: 'software-engineering',
    seniority: 'senior',
    ai_level: 4,
    ai_score: 90,
    tools: [],
    posted_at: '2026-09-24T08:00:00.000Z',
    url: `https://jobsbylevel.com/jobs/${slug}?utm_source=mcp`,
    source: 'Level (jobsbylevel.com)',
    ...overrides,
  };
}

function envelope(items: JobsByLevelItem[], total: number, page = 1, perPage = 20) {
  return { total, page, per_page: perPage, items };
}

type SearchArgs = Record<string, unknown> & { page: number };

interface Router {
  search?: (args: SearchArgs) => unknown;
  detail?: (slug: string) => unknown;
}

/** Route MCP `tools/call` bodies to per-tool handlers. A thrown/returned Error rejects. */
function routeMcp(router: Router) {
  return async (_url: string, body: { params: { name: string; arguments: Record<string, unknown> } }) => {
    const { name, arguments: args } = body.params;
    const out =
      name === 'search_jobs'
        ? router.search?.(args as SearchArgs)
        : name === 'get_job'
          ? router.detail?.(String(args.id_or_slug))
          : new Error(`unexpected tool ${name}`);
    if (out instanceof Error) throw out;
    if (out && typeof out === 'object' && 'data' in (out as Record<string, unknown>)) return out;
    return rpc(out);
  };
}

function searchCalls(): SearchArgs[] {
  return mockPost.mock.calls
    .filter((call) => call[1]?.params?.name === 'search_jobs')
    .map((call) => call[1].params.arguments as SearchArgs);
}

function detailCalls(): string[] {
  return mockPost.mock.calls
    .filter((call) => call[1]?.params?.name === 'get_job')
    .map((call) => String(call[1].params.arguments.id_or_slug));
}

function input(partial: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.JOBSBYLEVEL],
    descriptionDepth: 'board',
    ...partial,
  });
}

async function scrape(partial: Partial<ScraperInputDto> = {}) {
  const service = new JobsByLevelService();
  const result = await service.scrape(input(partial));
  return { ...result, jobs: result.jobs as JobsByLevelJobPost[] };
}

function byId(jobs: JobsByLevelJobPost[], slug: string): JobsByLevelJobPost {
  const job = jobs.find((j) => j.id === `jobsbylevel-${slug}`);
  if (!job) throw new Error(`no job ${slug}`);
  return job;
}

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockSetHeaders.mockReset();
  mockCreateHttpClient.mockClear();
  for (const key of ENV_KEYS) delete process.env[key];
  resetJobsByLevelState();
  clock = NOW;
  jobsByLevelRuntime.now = () => clock;
  jobsByLevelRuntime.sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  jobsByLevelRuntime.now = originalRuntime.now;
  jobsByLevelRuntime.sleep = originalRuntime.sleep;
  for (const key of ENV_KEYS) delete process.env[key];
  resetJobsByLevelState();
});

describe('JobsByLevelService — Spec 1693', () => {
  describe('registration', () => {
    it('resolves through JobsByLevelModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [JobsByLevelModule] }).compile();
      expect(moduleRef.get(JobsByLevelService)).toBeInstanceOf(JobsByLevelService);
      await moduleRef.close();
    });

    it('registers under Site.JOBSBYLEVEL ("jobsbylevel"), distinct from Site.HIGHLEVEL', () => {
      expect(Site.JOBSBYLEVEL).toBe('jobsbylevel');
      expect(JOBSBYLEVEL_SITE).toBe(Site.JOBSBYLEVEL);
      expect(Site.HIGHLEVEL).toBe('gohighlevel');
      expect(Site.JOBSBYLEVEL).not.toBe(Site.HIGHLEVEL);
    });

    it('declares niche, non-ATS plugin metadata', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, JobsByLevelService);
      expect(meta).toMatchObject({ site: 'jobsbylevel', name: 'Level (jobsbylevel.com)', category: 'niche' });
      expect(meta.isAts).toBeFalsy();
    });
  });

  describe('mapping (MCP search_jobs fixture)', () => {
    beforeEach(() => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE) }));
    });

    it('maps every well-formed item and skips the one without a url', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toHaveLength(7);
      expect(diagnostics).toBeUndefined();
      expect(jobs.map((j) => j.id)).not.toContain('jobsbylevel-broken-listing-at-example-000000');
      expect(warn.mock.calls.some(([m]) => String(m).includes('broken-listing-at-example-000000'))).toBe(true);
    });

    it('maps a live item field by field', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.thinkingMachines);
      expect(job).toMatchObject({
        title: 'Research, Finetuning Science',
        companyName: 'Thinking Machines Lab',
        companyUrl: 'https://jobsbylevel.com/companies/thinking-machines-lab',
        jobUrl: `https://jobsbylevel.com/jobs/${SLUG.thinkingMachines}?utm_source=mcp`,
        jobUrlDirect: null,
        countryCode: 'US',
        isRemote: true,
        jobType: [JobType.FULL_TIME],
        employmentType: 'FullTime',
        datePosted: '2026-09-16',
        datePostedAt: '2026-09-16T23:21:35.061Z',
        jobLevel: 'senior',
        jobFunction: 'Research',
        skills: ['pytorch', 'tensorflow', 'jax', 'python'],
        site: 'jobsbylevel',
        aiLevel: 4,
        description: null,
      });
      expect(job.jobUrl).toContain('jobsbylevel.com/jobs/');
      expect(job.location).toMatchObject({ city: 'San Francisco', country: 'United States' });
      expect(job.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 350000,
        maxAmount: 475000,
        currency: 'USD',
      });
    });

    it('never emits an ATS link or an apply redirect', async () => {
      const { jobs } = await scrape();
      for (const job of jobs) {
        expect(job.jobUrlDirect).toBeNull();
        expect(job.applyUrl ?? null).toBeNull();
        expect(job.jobUrl).not.toContain('/go/');
      }
    });

    it('reads the country-code-state-city label form', async () => {
      const { jobs } = await scrape();
      expect(byId(jobs, SLUG.snowflake).location).toMatchObject({
        city: 'Bellevue',
        state: 'WA',
        country: 'United States',
      });
    });

    it('keeps "UK - London" in the United Kingdom', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.faculty);
      expect(job.countryCode).toBe('GB');
      expect(job.location).toMatchObject({ city: 'London', country: 'United Kingdom' });
    });

    it('maps the GBP range and the level of the live Coinbase listing', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.coinbase);
      expect(job.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 55620,
        maxAmount: 61800,
        currency: 'GBP',
      });
      expect(job.aiLevel).toBe(1);
      expect(job.jobType).toBeNull();
      expect(job.datePostedAt).toBe('2026-09-24T18:55:42.000Z');
    });

    it('adds the country to "San Francisco, CA" and derives the level from ai_score', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.exampleUs);
      expect(job.location).toMatchObject({ city: 'San Francisco', state: 'CA', country: 'United States' });
      expect(job.isRemote).toBe(false);
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.aiLevel).toBe(4);
    });

    it('turns a UK country-wide listing into one GB location, never a duplicated one', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.exampleUk);
      expect(job.countryCode).toBe('GB');
      expect(job.location).toEqual(expect.objectContaining({ country: 'United Kingdom' }));
      expect(job.location?.city ?? null).toBeNull();
      expect(job.locations ?? []).toHaveLength(1);
      expect(job.compensation).toMatchObject({
        interval: CompensationInterval.MONTHLY,
        minAmount: 2500,
        maxAmount: 3000,
        currency: 'GBP',
      });
      expect(job.jobType).toEqual([JobType.PART_TIME]);
      expect(job.jobLevel).toBeNull();
      expect(job.jobFunction).toBe('Customer Support');
      expect(job.aiLevel).toBe(2);
    });

    it('marks sponsored listings and unions tools with skills case-insensitively', async () => {
      const { jobs } = await scrape();
      const job = byId(jobs, SLUG.exampleSponsored);
      expect(job.listingType).toBe('sponsored');
      expect(job.skills).toEqual(['SQL', 'Python', 'dbt']);
      expect(job.workFromHomeType).toBe('Hybrid');
      expect(job.location).toMatchObject({ city: 'Paris', country: 'France' });
      expect(job.compensation).toBeNull();
      expect(job.jobType).toEqual([JobType.CONTRACT]);
      expect(job.aiLevel).toBe(3);
    });

    it('leaves aiLevel out when JOBSBYLEVEL_EMIT_AI_LEVEL=false', async () => {
      process.env.JOBSBYLEVEL_EMIT_AI_LEVEL = 'false';
      const { jobs } = await scrape();
      for (const job of jobs) expect(Object.prototype.hasOwnProperty.call(job, 'aiLevel')).toBe(false);
    });

    it('parses the live wire format (JSON text inside a tools/call result)', async () => {
      mockPost.mockReset();
      mockPost.mockResolvedValueOnce({ data: clone(RPC_WIRE) });
      const { jobs } = await scrape();
      expect(jobs.map((j) => j.id)).toEqual([
        `jobsbylevel-${SLUG.thinkingMachines}`,
        `jobsbylevel-${SLUG.faculty}`,
      ]);
    });
  });

  describe('request construction', () => {
    beforeEach(() => {
      mockPost.mockImplementation(routeMcp({ search: () => envelope([], 0) }));
    });

    it('posts a JSON-RPC tools/call to /mcp with the honest User-Agent', async () => {
      await scrape({ searchTerm: 'machine learning' });
      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockPost.mock.calls[0];
      expect(url).toBe(JOBSBYLEVEL_MCP_URL);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'search_jobs', arguments: { query: 'machine learning', page: 1 } },
      });
      expect(config.headers.Accept).toContain('text/event-stream');
      expect(mockSetHeaders).toHaveBeenCalledWith({ 'User-Agent': JOBSBYLEVEL_USER_AGENT });
      expect(JOBSBYLEVEL_USER_AGENT).toMatch(/^Mozilla\/5\.0 \(compatible; EverJobs\/1\.0;/);
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: JOBSBYLEVEL_USER_AGENT,
          allowedRedirectHosts: ['jobsbylevel.com'],
          requestTimeout: 60,
        }),
      );
    });

    it('sends remote, a city, the company and the AI level range server-side', async () => {
      process.env.JOBSBYLEVEL_MIN_AI_LEVEL = '3';
      process.env.JOBSBYLEVEL_MAX_AI_LEVEL = '4';
      await scrape({ isRemote: true, location: 'london', companySlug: 'thinking-machines-lab' });
      expect(searchCalls()[0]).toEqual({
        remote: true,
        city: 'london',
        company: 'thinking machines lab',
        ai_level_min: 3,
        ai_level_max: 4,
        page: 1,
      });
    });

    it('does not send a city when the location names a country', async () => {
      await scrape({ location: 'United Kingdom' });
      expect(searchCalls()[0]).toEqual({ page: 1 });
    });

    it('omits remote when isRemote is false (the DTO default)', async () => {
      await scrape();
      expect(searchCalls()[0]).toEqual({ page: 1 });
    });
  });

  describe('robots.txt guard', () => {
    it('never requests /api/, /feeds/, /go/, /md/ or a query URL, on either transport', async () => {
      mockPost.mockImplementation(
        routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => clone(GET_JOB) }),
      );
      mockGet.mockImplementation(async (url: string) =>
        url.endsWith('/feed.xml') ? { data: FEED_XML } : { data: DETAIL_HTML },
      );
      await scrape({ descriptionDepth: 'detail-all' });
      resetJobsByLevelState();
      process.env.JOBSBYLEVEL_TRANSPORT = 'feed';
      await scrape({ descriptionDepth: 'detail-all' });

      const urls = [...mockPost.mock.calls, ...mockGet.mock.calls].map((call) => String(call[0]));
      expect(urls.length).toBeGreaterThan(5);
      for (const url of urls) {
        const parsed = new URL(url);
        expect(parsed.hostname).toBe('jobsbylevel.com');
        expect(parsed.search).toBe('');
        expect(parsed.pathname).not.toMatch(/^\/(api|feeds|go|md)(\/|$)/);
      }
      expect(urls).toContain('https://jobsbylevel.com/mcp');
      expect(urls).toContain('https://jobsbylevel.com/feed.xml');
    });
  });

  describe('pagination', () => {
    function pages(total: number) {
      return routeMcp({
        search: (args) => {
          const start = (args.page - 1) * 20;
          const count = Math.max(0, Math.min(20, total - start));
          return envelope(
            Array.from({ length: count }, (_, i) => makeItem(start + i)),
            total,
            args.page,
          );
        },
      });
    }

    it('stops at resultsWanted', async () => {
      mockPost.mockImplementation(pages(1000));
      const { jobs } = await scrape({ resultsWanted: 3 });
      expect(jobs).toHaveLength(3);
      expect(searchCalls()).toHaveLength(1);
    });

    it('walks pages until resultsWanted is met', async () => {
      mockPost.mockImplementation(pages(1000));
      const { jobs } = await scrape({ resultsWanted: 50 });
      expect(jobs).toHaveLength(50);
      expect(searchCalls().map((a) => a.page)).toEqual([1, 2, 3]);
    });

    it('stops when a page is short', async () => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE) }));
      await scrape({ resultsWanted: 100 });
      expect(searchCalls()).toHaveLength(1);
    });

    it('stops when page * per_page reaches total', async () => {
      mockPost.mockImplementation(pages(40));
      const { jobs } = await scrape({ resultsWanted: 100 });
      expect(jobs).toHaveLength(40);
      expect(searchCalls()).toHaveLength(2);
    });

    it('hard-stops at the page cap (10 by default, JOBSBYLEVEL_MAX_PAGES overrides)', async () => {
      mockPost.mockImplementation(pages(100_000));
      const first = await scrape({ resultsWanted: 1000 });
      expect(searchCalls()).toHaveLength(10);
      expect(first.jobs).toHaveLength(200);

      mockPost.mockClear();
      resetJobsByLevelState();
      process.env.JOBSBYLEVEL_MAX_PAGES = '3';
      await scrape({ resultsWanted: 1000 });
      expect(searchCalls()).toHaveLength(3);
    });

    it('maps offset to a page and a skip when no client filter is active', async () => {
      mockPost.mockImplementation(pages(1000));
      const { jobs } = await scrape({ offset: 50, resultsWanted: 5 });
      expect(searchCalls()[0].page).toBe(3);
      expect(jobs[0].id).toBe('jobsbylevel-role-50-at-example-000050');
      expect(jobs).toHaveLength(5);
    });

    it('skips the first offset matches when a client filter is active', async () => {
      mockPost.mockImplementation(
        routeMcp({
          search: (args) =>
            args.page === 1
              ? envelope(
                  Array.from({ length: 20 }, (_, i) =>
                    makeItem(i, { employment_type: i % 2 === 0 ? 'FullTime' : 'Part-time' }),
                  ),
                  20,
                )
              : envelope([], 20, args.page),
        }),
      );
      const { jobs } = await scrape({ jobType: JobType.FULL_TIME, offset: 2, resultsWanted: 3 });
      expect(searchCalls()[0].page).toBe(1);
      expect(jobs.map((j) => j.id)).toEqual([
        'jobsbylevel-role-4-at-example-000004',
        'jobsbylevel-role-6-at-example-000006',
        'jobsbylevel-role-8-at-example-000008',
      ]);
    });

    it('drops a listing repeated on a later page', async () => {
      mockPost.mockImplementation(
        routeMcp({
          search: (args) =>
            args.page === 1
              ? envelope(Array.from({ length: 20 }, (_, i) => makeItem(i)), 25)
              : envelope([makeItem(19), makeItem(20)], 25, 2),
        }),
      );
      const { jobs } = await scrape({ resultsWanted: 30 });
      expect(jobs).toHaveLength(21);
      expect(new Set(jobs.map((j) => j.id)).size).toBe(21);
    });
  });

  describe('client-side filters', () => {
    beforeEach(() => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE) }));
    });

    const ids = (jobs: JobsByLevelJobPost[]) => jobs.map((j) => (j.id ?? '').replace(/^jobsbylevel-/, '')).sort();

    it('hoursOld drops stale listings', async () => {
      const { jobs } = await scrape({ hoursOld: 24 });
      expect(ids(jobs)).toEqual([SLUG.coinbase, SLUG.exampleUs].sort());
    });

    it('jobType keeps only matching listings (unknown types drop)', async () => {
      const { jobs } = await scrape({ jobType: JobType.FULL_TIME });
      expect(ids(jobs)).toEqual(
        [SLUG.thinkingMachines, SLUG.snowflake, SLUG.faculty, SLUG.exampleUs].sort(),
      );
    });

    it('location matches a city', async () => {
      const { jobs } = await scrape({ location: 'london' });
      expect(ids(jobs)).toEqual([SLUG.faculty]);
    });

    it.each(['united kingdom', 'gb', 'UK'])('location %p matches by country', async (location) => {
      const { jobs } = await scrape({ location });
      expect(ids(jobs)).toEqual([SLUG.faculty, SLUG.coinbase, SLUG.exampleUk].sort());
    });

    it('a two-letter location matches whole words only', async () => {
      const { jobs } = await scrape({ location: 'wa' });
      expect(ids(jobs)).toEqual([SLUG.snowflake]);
    });

    it('the default country (USA) does not drop non-US listings', async () => {
      const dto = input();
      expect(dto.country).toBe(Country.USA);
      const { jobs } = await scrape({ country: Country.USA });
      expect(jobs).toHaveLength(7);
      expect(jobs.filter((j) => j.countryCode === 'GB')).toHaveLength(3);
    });

    it('JOBSBYLEVEL_MIN_AI_LEVEL=3 keeps levels 3 and 4 and asks the server for them', async () => {
      process.env.JOBSBYLEVEL_MIN_AI_LEVEL = '3';
      const { jobs } = await scrape();
      expect(jobs.every((j) => (j.aiLevel ?? 0) >= 3)).toBe(true);
      expect(ids(jobs)).toEqual(
        [SLUG.thinkingMachines, SLUG.snowflake, SLUG.faculty, SLUG.exampleUs, SLUG.exampleSponsored].sort(),
      );
      expect(searchCalls()[0].ai_level_min).toBe(3);
    });

    it('JOBSBYLEVEL_MAX_AI_LEVEL=2 keeps levels 1 and 2', async () => {
      process.env.JOBSBYLEVEL_MAX_AI_LEVEL = '2';
      const { jobs } = await scrape();
      expect(ids(jobs)).toEqual([SLUG.coinbase, SLUG.exampleUk].sort());
    });

    it('a minimum above the maximum is bad_input and makes no request', async () => {
      process.env.JOBSBYLEVEL_MIN_AI_LEVEL = '4';
      process.env.JOBSBYLEVEL_MAX_AI_LEVEL = '2';
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('bad_input');
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('an out-of-range level env var is ignored with a warning', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      process.env.JOBSBYLEVEL_MIN_AI_LEVEL = '9';
      const { jobs } = await scrape();
      expect(jobs).toHaveLength(7);
      expect(searchCalls()[0].ai_level_min).toBeUndefined();
      expect(warn.mock.calls.some(([m]) => String(m).includes('JOBSBYLEVEL_MIN_AI_LEVEL'))).toBe(true);
    });

    it('JOBSBYLEVEL_CATEGORIES filters on the category slug', async () => {
      process.env.JOBSBYLEVEL_CATEGORIES = 'research, data';
      const { jobs } = await scrape();
      expect(ids(jobs)).toEqual(
        [SLUG.thinkingMachines, SLUG.snowflake, SLUG.faculty, SLUG.exampleSponsored].sort(),
      );
    });

    it('companySlug keeps the matching Level company only', async () => {
      const { jobs } = await scrape({ companySlug: 'example-retail' });
      expect(ids(jobs)).toEqual([SLUG.exampleSponsored]);
      expect(searchCalls()[0].company).toBe('example retail');
    });

    it('isRemote keeps listings flagged remote', async () => {
      const { jobs } = await scrape({ isRemote: true });
      expect(jobs.every((j) => j.isRemote === true)).toBe(true);
      expect(ids(jobs)).not.toContain(SLUG.exampleUs);
      expect(ids(jobs)).not.toContain(SLUG.exampleUk);
      expect(jobs).toHaveLength(5);
    });
  });

  describe('descriptions (detail budget)', () => {
    let inFlight = 0;
    let maxInFlight = 0;

    beforeEach(() => {
      inFlight = 0;
      maxInFlight = 0;
    });

    function withConcurrencyProbe(router: Router) {
      const route = routeMcp(router);
      return async (url: string, body: never) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return route(url, body);
      };
    }

    it("depth 'board' makes no detail calls", async () => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => clone(GET_JOB) }));
      await scrape({ descriptionDepth: 'board' });
      expect(detailCalls()).toEqual([]);
    });

    it('the default depth reads at most 5 details, in order, one at a time', async () => {
      mockPost.mockImplementation(
        withConcurrencyProbe({ search: () => clone(SEARCH_PAGE), detail: () => clone(GET_JOB) }),
      );
      const { jobs } = await scrape({ descriptionDepth: undefined });
      expect(detailCalls()).toEqual(jobs.slice(0, 5).map((j) => (j.id ?? '').replace(/^jobsbylevel-/, '')));
      expect(maxInFlight).toBe(1);
    });

    it("'detail-all' reads at most 25 details", async () => {
      mockPost.mockImplementation(
        routeMcp({
          search: (args) =>
            envelope(
              Array.from({ length: 20 }, (_, i) => makeItem((args.page - 1) * 20 + i)),
              40,
              args.page,
            ),
          detail: (slug) => ({ ...clone(GET_JOB), slug }),
        }),
      );
      const { jobs } = await scrape({ descriptionDepth: 'detail-all', resultsWanted: 40 });
      expect(jobs).toHaveLength(40);
      expect(detailCalls()).toHaveLength(25);
    });

    it('stops reading details when the 30 s time budget is spent', async () => {
      mockPost.mockImplementation(async (url: string, body: never) => {
        const out = await routeMcp({
          search: () => envelope(Array.from({ length: 20 }, (_, i) => makeItem(i)), 20),
          detail: (slug) => ({ ...clone(GET_JOB), slug }),
        })(url, body);
        if ((body as { params: { name: string } }).params.name === 'get_job') clock += 10_000;
        return out;
      });
      const { jobs } = await scrape({ descriptionDepth: 'detail-all', resultsWanted: 20 });
      expect(jobs).toHaveLength(20);
      expect(detailCalls().length).toBeGreaterThan(0);
      expect(detailCalls().length).toBeLessThanOrEqual(3);
    });

    it('a failed detail keeps the job without a description and reports partial', async () => {
      mockPost.mockImplementation(
        routeMcp({
          search: () => clone(SEARCH_PAGE),
          detail: (slug) => (slug === SLUG.snowflake ? httpError(500) : { ...clone(GET_JOB), slug }),
        }),
      );
      const { jobs, diagnostics } = await scrape({ descriptionDepth: 'detail-25' });
      expect(jobs).toHaveLength(7);
      expect(byId(jobs, SLUG.snowflake).description).toBeNull();
      expect(byId(jobs, SLUG.thinkingMachines).description).toContain('Coinbase');
      expect(diagnostics).toEqual({ reason: 'partial', detail: '1/5 detail fetches failed' });
    });

    it('merges get_job: plain-text description, skills, no AI level text', async () => {
      const coinbaseOnly = envelope(
        SEARCH_PAGE.items.filter((i: JobsByLevelItem) => i.slug === SLUG.coinbase),
        1,
      );
      mockPost.mockImplementation(routeMcp({ search: () => coinbaseOnly, detail: () => clone(GET_JOB) }));
      for (const format of [DescriptionFormat.HTML, DescriptionFormat.MARKDOWN, DescriptionFormat.PLAIN]) {
        resetJobsByLevelState();
        const { jobs } = await scrape({ descriptionDepth: 'detail-25', descriptionFormat: format });
        const job = byId(jobs, SLUG.coinbase);
        expect(job.description).toBe(GET_JOB.description_text);
        expect(job.description).not.toMatch(/AI Level/i);
        expect(job.skills).toEqual(['aml', 'investigations', 'compliance', 'sar-filing', 'financial-crime']);
        expect(job.compensation).toMatchObject({ minAmount: 55620, maxAmount: 61800, currency: 'GBP' });
      }
    });

    it('falls back to the salary in the description and extracts emails', async () => {
      const facultyOnly = envelope(
        SEARCH_PAGE.items.filter((i: JobsByLevelItem) => i.slug === SLUG.faculty),
        1,
      );
      mockPost.mockImplementation(
        routeMcp({
          search: () => facultyOnly,
          detail: () => ({
            ...clone(GET_JOB),
            slug: SLUG.faculty,
            salary_min: null,
            salary_max: null,
            salary_currency: null,
            description_text: 'Apply via careers@example.com. Salary: £55,620 - £61,800 per year.',
          }),
        }),
      );
      const { jobs } = await scrape({ descriptionDepth: 'detail-25' });
      const job = byId(jobs, SLUG.faculty);
      expect(job.emails).toEqual(['careers@example.com']);
      expect(job.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 55620,
        maxAmount: 61800,
        currency: 'GBP',
      });
    });

    it('caps each detail request at 20 s, or at requestTimeout when lower', async () => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => clone(GET_JOB) }));
      await scrape({ descriptionDepth: 'detail-25', resultsWanted: 1 });
      const detailConfig = mockPost.mock.calls.find((c) => c[1].params.name === 'get_job')?.[2];
      expect(detailConfig.timeout).toBe(20_000);

      mockPost.mockClear();
      resetJobsByLevelState();
      await scrape({ descriptionDepth: 'detail-25', resultsWanted: 1, requestTimeout: 5 });
      const lowered = mockPost.mock.calls.find((c) => c[1].params.name === 'get_job')?.[2];
      expect(lowered.timeout).toBe(5_000);
    });
  });

  describe('errors and diagnostics', () => {
    const fullPage = (page: number) =>
      envelope(Array.from({ length: 20 }, (_, i) => makeItem((page - 1) * 20 + i)), 100, page);

    it('a 503 on page 2 keeps page 1 and reports fetch_error', async () => {
      mockPost.mockImplementation(
        routeMcp({ search: (args) => (args.page === 1 ? fullPage(1) : httpError(503)) }),
      );
      const { jobs, diagnostics } = await scrape({ resultsWanted: 40 });
      expect(jobs).toHaveLength(20);
      expect(diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('an HTML body on page 1 is blocked (fallback off)', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = 'false';
      mockPost.mockResolvedValue({ data: '<!DOCTYPE html><title>Just a moment...</title>' });
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('a wrong envelope is unknown (fallback off)', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = '0';
      mockPost.mockImplementation(routeMcp({ search: () => ({ results: [] }) }));
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('unknown');
      expect(diagnostics?.detail).toContain('envelope');
    });

    it('a JSON-RPC error is reported with its message', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = 'off';
      mockPost.mockResolvedValue({
        data: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
      });
      const { diagnostics } = await scrape();
      expect(diagnostics).toEqual({ reason: 'unknown', detail: 'MCP error -32601: Method not found' });
    });

    it('a rate-limit tool error is fetch_error', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = 'no';
      mockPost.mockResolvedValue({
        data: {
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded, retry later' }] },
        },
      });
      const { diagnostics } = await scrape();
      expect(diagnostics?.reason).toBe('fetch_error');
    });

    it('reads an SSE-framed response', async () => {
      const message = rpc(clone(SEARCH_PAGE)).data;
      mockPost.mockResolvedValue({ data: `event: message\ndata: ${JSON.stringify(message)}\n\n` });
      const { jobs } = await scrape();
      expect(jobs).toHaveLength(7);
    });

    it('falls back to the RSS feed when the MCP listing fails before any job', async () => {
      mockPost.mockRejectedValue(httpError(404));
      mockGet.mockResolvedValue({ data: FEED_XML });
      const { jobs, diagnostics } = await scrape();
      expect(mockGet.mock.calls[0][0]).toBe('https://jobsbylevel.com/feed.xml');
      expect(jobs).toHaveLength(4);
      expect(diagnostics?.reason).toBe('partial');
      expect(diagnostics?.detail).toContain('served from the RSS feed');
    });

    it('reports the MCP failure when the fallback also has nothing', async () => {
      mockPost.mockRejectedValue(httpError(404));
      mockGet.mockRejectedValue(httpError(503));
      const { jobs, diagnostics } = await scrape();
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('bad_input');
      expect(diagnostics?.detail).toContain('404');
    });

    it.each([
      [429, 'fetch_error'],
      [403, 'blocked'],
    ])('never falls back to the feed after a %p on the MCP listing', async (status, reason) => {
      mockPost.mockRejectedValue(httpError(status));
      mockGet.mockResolvedValue({ data: FEED_XML });
      const { jobs, diagnostics } = await scrape();
      expect(mockGet).not.toHaveBeenCalled();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe(reason);
    });

    it('never falls back to the feed after a rate-limit tool error', async () => {
      mockPost.mockResolvedValue({
        data: {
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded, retry later' }] },
        },
      });
      mockGet.mockResolvedValue({ data: FEED_XML });
      const { diagnostics } = await scrape();
      expect(mockGet).not.toHaveBeenCalled();
      expect(diagnostics?.reason).toBe('fetch_error');
    });

    it('stops MCP detail reads at the first refusal and keeps the listed jobs', async () => {
      mockPost.mockImplementation(
        routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => httpError(429) }),
      );
      const { jobs, diagnostics } = await scrape({ descriptionDepth: 'detail-25' });
      expect(detailCalls()).toHaveLength(1);
      expect(jobs).toHaveLength(7);
      expect(diagnostics?.reason).toBe('fetch_error');
      expect(diagnostics?.detail).toContain('429');
    });

    it('keeps reading details past a non-refusal failure', async () => {
      mockPost.mockImplementation(
        routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => httpError(503) }),
      );
      const { jobs, diagnostics } = await scrape({ descriptionDepth: 'detail-25' });
      // Bounded by the detail time budget, not by the first failure.
      expect(detailCalls().length).toBeGreaterThan(1);
      expect(jobs).toHaveLength(7);
      expect(diagnostics?.reason).toBe('partial');
    });

    it('JOBSBYLEVEL_FEED_FALLBACK=false keeps the MCP failure and never reads the feed', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = 'false';
      mockPost.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND jobsbylevel.com'), { code: 'ENOTFOUND' }));
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('resultsWanted 0 makes no request', async () => {
      const { jobs } = await scrape({ resultsWanted: 0 });
      expect(jobs).toEqual([]);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('cache', () => {
    beforeEach(() => {
      mockPost.mockImplementation(routeMcp({ search: () => clone(SEARCH_PAGE), detail: () => clone(GET_JOB) }));
    });

    it('two identical scrapes within the TTL make one request', async () => {
      await scrape({ searchTerm: 'engineer' });
      const second = await scrape({ searchTerm: 'engineer' });
      expect(searchCalls()).toHaveLength(1);
      expect(second.jobs).toHaveLength(7);
    });

    it('a different query makes a second request', async () => {
      await scrape({ searchTerm: 'engineer' });
      await scrape({ searchTerm: 'designer' });
      expect(searchCalls()).toHaveLength(2);
    });

    it('refetches after the TTL expires', async () => {
      await scrape();
      clock += 10 * 60_000;
      await scrape();
      expect(searchCalls()).toHaveLength(2);
    });

    it('never caches a failed response', async () => {
      process.env.JOBSBYLEVEL_FEED_FALLBACK = 'false';
      mockPost.mockResolvedValueOnce({ data: '<html>error</html>' });
      const first = await scrape();
      const second = await scrape();
      expect(first.jobs).toEqual([]);
      expect(second.jobs).toHaveLength(7);
      expect(searchCalls()).toHaveLength(2);
    });

    it('JOBSBYLEVEL_CACHE_TTL_MS=0 turns the cache off', async () => {
      process.env.JOBSBYLEVEL_CACHE_TTL_MS = '0';
      await scrape();
      await scrape();
      expect(searchCalls()).toHaveLength(2);
    });

    it('caches details by slug', async () => {
      await scrape({ descriptionDepth: 'detail-25' });
      await scrape({ descriptionDepth: 'detail-25' });
      expect(detailCalls()).toHaveLength(5);
    });
  });

  describe('pacing', () => {
    it('keeps sequential requests at least 1.1 s apart', async () => {
      const callTimes: number[] = [];
      const route = routeMcp({
        search: (args) =>
          envelope(Array.from({ length: 20 }, (_, i) => makeItem((args.page - 1) * 20 + i)), 60, args.page),
      });
      mockPost.mockImplementation(async (url: string, body: never) => {
        callTimes.push(clock);
        return route(url, body);
      });
      await scrape({ resultsWanted: 60 });
      expect(callTimes).toHaveLength(3);
      for (let i = 1; i < callTimes.length; i++) {
        expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(1_100);
      }
    });

    it('spaces two concurrent scrapes too (real clock)', async () => {
      // Concurrency needs a real timeline: the fake sleep above advances one
      // shared clock the moment it is called, which a parallel caller would see.
      jobsByLevelRuntime.now = originalRuntime.now;
      jobsByLevelRuntime.sleep = originalRuntime.sleep;
      const callTimes: number[] = [];
      const route = routeMcp({ search: () => clone(SEARCH_PAGE) });
      mockPost.mockImplementation(async (url: string, body: never) => {
        callTimes.push(Date.now());
        return route(url, body);
      });
      await Promise.all([scrape({ searchTerm: 'a' }), scrape({ searchTerm: 'b' })]);
      expect(callTimes).toHaveLength(2);
      // setTimeout may fire a millisecond or two early on some platforms.
      expect(Math.abs(callTimes[1] - callTimes[0])).toBeGreaterThanOrEqual(1_090);
    });
  });

  describe('RSS feed transport', () => {
    beforeEach(() => {
      process.env.JOBSBYLEVEL_TRANSPORT = 'feed';
      mockGet.mockImplementation(async (url: string) =>
        url.endsWith('/feed.xml') ? { data: FEED_XML } : { data: DETAIL_HTML },
      );
    });

    it('maps feed items: title split at the last " at ", slug ids, posting instants', async () => {
      const { jobs } = await scrape();
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet.mock.calls[0][1]).toMatchObject({ responseType: 'text' });
      expect(jobs).toHaveLength(4);
      expect(jobs[0]).toMatchObject({
        id: 'jobsbylevel-account-executive-enterprise-new-business-expansion-at-culture-amp-3aacff',
        title: 'Account Executive, Enterprise (New Business & Expansion)',
        companyName: 'Culture Amp',
        jobUrl:
          'https://jobsbylevel.com/jobs/account-executive-enterprise-new-business-expansion-at-culture-amp-3aacff',
        datePosted: '2026-09-24',
        datePostedAt: '2026-09-24T19:12:11.000Z',
        site: 'jobsbylevel',
        description: null,
        aiLevel: null,
      });
      // Same title and company under two slugs: two listings, both kept.
      expect(jobs[1].title).toBe(jobs[0].title);
      expect(jobs[1].id).not.toBe(jobs[0].id);
      expect(jobs[3]).toMatchObject({ title: 'Commercial Account Executive 2', companyName: 'Zscaler' });
    });

    it('reads listing pages for the default budget and maps their JSON-LD', async () => {
      const { jobs, diagnostics } = await scrape({
        descriptionDepth: 'detail-25',
        descriptionFormat: DescriptionFormat.HTML,
      });
      const pageCalls = mockGet.mock.calls.filter((c) => String(c[0]).includes('/jobs/'));
      expect(pageCalls).toHaveLength(4);
      expect(pageCalls[0][1]).toMatchObject({ timeout: 20_000, responseType: 'text' });
      expect(diagnostics).toBeUndefined();
      const job = jobs[2];
      expect(job.description).toContain('<strong>What you’ll do:');
      expect(job.countryCode).toBe('GB');
      expect(job.isRemote).toBe(true);
      expect(job.atsId).toBe('8224726');
      expect(job.aiLevel).toBe(1);
      expect(job.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 55620,
        maxAmount: 61800,
        currency: 'GBP',
      });
      expect(job.description).not.toMatch(/AI Level/i);
    });

    it.each([
      [DescriptionFormat.MARKDOWN, (d: string) => expect(d).toMatch(/\*\*What you’ll do:\*\*/)],
      [DescriptionFormat.PLAIN, (d: string) => expect(d).not.toMatch(/<[a-z]/i)],
    ])('converts the JSON-LD description to %s', async (format, check) => {
      const { jobs } = await scrape({ descriptionDepth: 'detail-25', descriptionFormat: format });
      const description = jobs[0].description ?? '';
      expect(description).toContain('Own end-to-end investigations');
      expect(description).not.toContain('<p>');
      check(description);
    });

    it('searchTerm and hoursOld filter the feed client-side', async () => {
      clock = Date.parse('2026-09-24T19:30:00.000Z');
      const byTerm = await scrape({ searchTerm: 'zscaler' });
      expect(byTerm.jobs.map((j) => j.companyName)).toEqual(['Zscaler']);
      const byAge = await scrape({ hoursOld: 0.5 });
      expect(byAge.jobs).toHaveLength(2);
    });

    it('isRemote is judged on the listing page, within the detail budget', async () => {
      const { jobs } = await scrape({ isRemote: true, descriptionDepth: 'detail-25' });
      expect(jobs).toHaveLength(4);
      expect(jobs.every((j) => j.isRemote === true)).toBe(true);
    });

    it('stops listing-page reads at the first refusal', async () => {
      mockGet.mockImplementation(async (url: string) => {
        if (url.endsWith('/feed.xml')) return { data: FEED_XML };
        throw httpError(429);
      });
      const { jobs, diagnostics } = await scrape({ isRemote: true, descriptionDepth: 'detail-25' });
      // One feed read, one listing page, then nothing.
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('fetch_error');
    });

    it('stops enrichment reads at a challenge page', async () => {
      mockGet.mockImplementation(async (url: string) =>
        url.endsWith('/feed.xml')
          ? { data: FEED_XML }
          : { data: '<!DOCTYPE html><html><title>Just a moment...</title></html>' },
      );
      const { jobs, diagnostics } = await scrape({ descriptionDepth: 'detail-25' });
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(jobs).toHaveLength(4);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it("isRemote with depth 'board' is bad_input on the feed", async () => {
      const { jobs, diagnostics } = await scrape({ isRemote: true, descriptionDepth: 'board' });
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('bad_input');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('jobType cannot be judged on the feed and is bad_input', async () => {
      const { diagnostics } = await scrape({ jobType: JobType.FULL_TIME });
      expect(diagnostics?.reason).toBe('bad_input');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('an HTML challenge instead of RSS is blocked', async () => {
      mockGet.mockReset();
      mockGet.mockResolvedValue({ data: '<!DOCTYPE html><html><title>Just a moment...</title></html>' });
      const { jobs, diagnostics } = await scrape();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('a failed listing page keeps the job and reports partial', async () => {
      mockGet.mockReset();
      mockGet.mockImplementation(async (url: string) => {
        if (url.endsWith('/feed.xml')) return { data: FEED_XML };
        if (url.endsWith('-533601')) throw Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
        return { data: DETAIL_HTML };
      });
      const { jobs, diagnostics } = await scrape({ descriptionDepth: 'detail-25' });
      expect(jobs).toHaveLength(4);
      expect(jobs[3].description).toBeNull();
      expect(diagnostics).toEqual({ reason: 'partial', detail: '1/4 detail fetches failed' });
    });

    it('offset skips feed matches', async () => {
      const { jobs } = await scrape({ offset: 3 });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].companyName).toBe('Zscaler');
    });
  });
});
