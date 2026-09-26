import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  Country,
  DatePostedBasis,
  DatePostedPrecision,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockPost = jest.fn();
const mockSetHeaders = jest.fn();
const mockSleep = jest.fn(() => Promise.resolve());
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      post: mockPost,
      setHeaders: mockSetHeaders,
    })),
    randomSleep: (...args: unknown[]) => mockSleep(...(args as [])),
  };
});

import { IndeedModule, IndeedService } from '../src';
import {
  INDEED_ATTRIBUTE_MAPPING_ENV,
  INDEED_FORMATTED_LOCATION_ENV,
  INDEED_MAX_PAGES_ENV,
  JOB_SEARCH_QUERY,
} from '../src/indeed.constants';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}
const PAGE1 = JSON.parse(fixture('indeed-jobsearch-page1.json'));
const PAGE2 = JSON.parse(fixture('indeed-jobsearch-page2.json'));
const VALIDATION_ERROR = JSON.parse(fixture('indeed-graphql-validation-error.json'));
const WAF_BLOCK_HTML = fixture('indeed-waf-block.html');

const FETCHED_AT = Date.parse('2026-09-24T20:00:03Z');
const ENV_KEYS = [
  INDEED_ATTRIBUTE_MAPPING_ENV,
  INDEED_FORMATTED_LOCATION_ENV,
  INDEED_MAX_PAGES_ENV,
  'EVER_JOBS_POSTED_TIME_DETAIL',
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Page 1 with no next cursor, so a scrape stops after one request. */
function lastPage1(): unknown {
  const page = clone(PAGE1);
  page.data.jobSearch.pageInfo.nextCursor = null;
  return page;
}

function ok(body: unknown) {
  return { status: 200, data: body };
}

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

/** A page of `count` unique jobs whose cursor never runs out (until `lastPage`). */
function syntheticPage(page: number, count: number, lastPage = Infinity): unknown {
  return {
    data: {
      jobSearch: {
        pageInfo: { nextCursor: page >= lastPage ? null : `cursor-${page + 1}` },
        results: Array.from({ length: count }, (_, i) => ({
          job: { key: `p${page}-${i}`, title: `Job ${page}-${i}`, attributes: [] },
        })),
      },
    },
  };
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.INDEED],
    searchTerm: 'engineer',
    country: Country.USA,
    resultsWanted: 10,
    ...overrides,
  });
}

/**
 * Spec 1702 — Indeed remote/job-type/location mapping, posted time and diagnostics.
 */
describe('IndeedService — Spec 1702', () => {
  let service: IndeedService;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    const moduleRef = await Test.createTestingModule({ imports: [IndeedModule] }).compile();
    service = moduleRef.get(IndeedService);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    mockPost.mockReset();
    mockSetHeaders.mockReset();
    mockSleep.mockClear();
    for (const key of ENV_KEYS) delete process.env[key];
    jest.spyOn(Date, 'now').mockReturnValue(FETCHED_AT);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('mapping', () => {
    it('detects remote and hybrid from attributes and the formatted location, never the description', async () => {
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(diagnostics).toBeUndefined();
      expect(jobs.map((j) => j.id)).toEqual([
        'in-aaa0000000000001',
        'in-aaa0000000000002',
        'in-aaa0000000000003',
        'in-aaa0000000000004',
      ]);
      expect(jobs.map((j) => j.isRemote)).toEqual([false, true, true, false]);
      expect(jobs.map((j) => j.workFromHomeType)).toEqual([undefined, 'Remote', 'Remote', 'Hybrid']);
      // Job 1's description says "work from home" and a skill label starts with "Remote".
      expect(jobs[0].description).toContain('work from home');
      expect(jobs[0].emails).toEqual(['jobs@example.com']);
    });

    it('reads job types from attribute codes and whole labels', async () => {
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs } = await service.scrape(input());

      expect(jobs.map((j) => j.jobType)).toEqual([
        [JobType.FULL_TIME],
        [JobType.CONTRACT],
        [JobType.PART_TIME],
        [JobType.PERMANENT],
      ]);
    });

    it('builds the location from structured fields, falling back to the formatted label', async () => {
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs } = await service.scrape(input());

      expect(jobs[0].location).toMatchObject({
        city: 'New York',
        state: 'NY',
        country: 'United States',
        postalCode: '10017',
        text: 'New York, NY 10017',
      });
      expect(jobs[1].location).toMatchObject({ state: null, country: 'US', text: 'Remote' });
      expect(jobs[2].location).toMatchObject({
        city: 'Austin',
        state: 'TX',
        country: 'US',
        postalCode: '78701',
        text: 'Remote in Austin, TX 78701',
      });
      expect(jobs[3].location).toMatchObject({ city: 'London', country: 'GB', text: 'Hybrid work in London' });
    });

    it('keeps the posted instant from datePublished (Spec 1696)', async () => {
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs } = await service.scrape(input());

      // Epoch milliseconds.
      expect(jobs[0]).toMatchObject({
        datePosted: '2026-09-23',
        datePostedAt: '2026-09-23T00:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      });
      // Epoch seconds as a numeric string: this used to become null.
      expect(jobs[1]).toMatchObject({
        datePosted: '2026-09-23',
        datePostedAt: '2026-09-23T00:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
      });
      // No datePublished: the dateOnSite calendar date, day precision, no instant.
      expect(jobs[2]).toMatchObject({
        datePosted: '2026-09-20',
        datePostedPrecision: DatePostedPrecision.DAY,
        datePostedBasis: DatePostedBasis.DATE,
      });
      expect(jobs[2]).not.toHaveProperty('datePostedAt');
      // Neither: nothing is claimed.
      expect(jobs[3].datePosted).toBeNull();
      expect(jobs[3]).not.toHaveProperty('datePostedPrecision');
    });

    it('EVER_JOBS_POSTED_TIME_DETAIL=false keeps datePosted alone', async () => {
      process.env.EVER_JOBS_POSTED_TIME_DETAIL = 'false';
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs } = await service.scrape(input());

      expect(jobs[0].datePosted).toBe('2026-09-23');
      expect(jobs[0]).not.toHaveProperty('datePostedAt');
      expect(jobs[0]).not.toHaveProperty('datePostedPrecision');
    });

    it(`${INDEED_ATTRIBUTE_MAPPING_ENV}=false restores the pre-1702 isRemote/jobType mapping`, async () => {
      process.env[INDEED_ATTRIBUTE_MAPPING_ENV] = 'false';
      const page = lastPage1() as typeof PAGE1;
      page.data.jobSearch.results[3].job.attributes.push(
        { key: 'remotejob', label: 'Remote' },
        { key: 'job-types/fulltime', label: 'Full-time' },
      );
      mockPost.mockResolvedValueOnce(ok(page));

      const { jobs } = await service.scrape(input());

      expect(jobs.map((j) => j.isRemote)).toEqual([false, false, false, true]);
      expect(jobs.map((j) => j.jobType)).toEqual([null, null, null, [JobType.FULL_TIME]]);
      expect(jobs.some((j) => j.workFromHomeType !== undefined)).toBe(false);
    });

    it(`${INDEED_FORMATTED_LOCATION_ENV}=false restores the pre-1702 location`, async () => {
      process.env[INDEED_FORMATTED_LOCATION_ENV] = 'off';
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      const { jobs } = await service.scrape(input());

      expect({ ...jobs[0].location }).toEqual({ city: 'New York', state: 'NY', country: 'United States' });
      expect({ ...jobs[3].location }).toEqual({ city: null, state: null, country: null });
    });

    it('does not rewrite the request: same document, variables and filters as before', async () => {
      mockPost.mockResolvedValueOnce(ok(lastPage1()));

      await service.scrape(input({ isRemote: true, jobType: JobType.FULL_TIME, hoursOld: 48, location: 'Austin' }));

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe('https://apis.indeed.com/graphql');
      expect(body.query).toBe(JOB_SEARCH_QUERY);
      expect(body.variables).toEqual({
        what: 'engineer',
        location: 'Austin',
        radius: 50,
        fromAge: '2',
        filters: [
          { name: 'jobtype', value: JobType.FULL_TIME },
          { name: 'remotejob', value: 'true' },
        ],
      });
      expect(mockSetHeaders).toHaveBeenCalledWith(expect.objectContaining({ 'indeed-co': 'US' }));
    });
  });

  describe('paging', () => {
    it('follows the cursor, drops duplicate keys and sleeps only between pages', async () => {
      mockPost.mockResolvedValueOnce(ok(PAGE1)).mockResolvedValueOnce(ok(PAGE2));

      const { jobs, diagnostics } = await service.scrape(input({ resultsWanted: 20 }));

      expect(diagnostics).toBeUndefined();
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(mockPost.mock.calls[0][1].variables.cursor).toBeUndefined();
      expect(mockPost.mock.calls[1][1].variables.cursor).toBe('cursor-page-2');
      expect(mockSleep).toHaveBeenCalledTimes(1);
      expect(jobs.map((j) => j.id)).toEqual([
        'in-aaa0000000000001',
        'in-aaa0000000000002',
        'in-aaa0000000000003',
        'in-aaa0000000000004',
        'in-aaa0000000000005',
        'in-aaa0000000000006',
      ]);
      expect(jobs[4]).toMatchObject({ isRemote: true, workFromHomeType: 'Remote', jobType: [JobType.TEMPORARY] });
      expect(jobs[5]).toMatchObject({ isRemote: false, jobType: [JobType.INTERNSHIP] });
    });

    it('does not sleep or fetch again once enough jobs are collected', async () => {
      mockPost.mockResolvedValueOnce(ok(PAGE1));

      const { jobs } = await service.scrape(input({ resultsWanted: 4 }));

      expect(jobs).toHaveLength(4);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('stops at the page cap (10 by default)', async () => {
      let page = 0;
      mockPost.mockImplementation(async () => ok(syntheticPage(++page, 2)));

      const { jobs, diagnostics } = await service.scrape(input({ resultsWanted: 5000 }));

      expect(mockPost).toHaveBeenCalledTimes(10);
      expect(mockSleep).toHaveBeenCalledTimes(9);
      expect(jobs).toHaveLength(20);
      expect(diagnostics).toBeUndefined();
    });

    it(`${INDEED_MAX_PAGES_ENV} moves the cap, and 0 removes it`, async () => {
      let page = 0;
      mockPost.mockImplementation(async () => ok(syntheticPage(++page, 1, 15)));

      process.env[INDEED_MAX_PAGES_ENV] = '3';
      await service.scrape(input({ resultsWanted: 5000 }));
      expect(mockPost).toHaveBeenCalledTimes(3);

      mockPost.mockClear();
      page = 0;
      process.env[INDEED_MAX_PAGES_ENV] = '0';
      const { jobs } = await service.scrape(input({ resultsWanted: 5000 }));
      expect(mockPost).toHaveBeenCalledTimes(15);
      expect(jobs).toHaveLength(15);
    });
  });

  describe('diagnostics', () => {
    it('a 400 validation error is bad_input naming the field', async () => {
      mockPost.mockRejectedValueOnce(httpError(400, VALIDATION_ERROR));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('bad_input');
      expect(diagnostics?.detail).toContain('dateOnSite');
    });

    it('a 403 edge block page is blocked', async () => {
      mockPost.mockRejectedValueOnce(httpError(403, WAF_BLOCK_HTML));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
      expect(diagnostics?.detail).toContain('cloudflare');
    });

    it('a 200 block page is blocked, not a silent empty', async () => {
      mockPost.mockResolvedValueOnce(ok(WAF_BLOCK_HTML));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('a 200 GraphQL error envelope with no jobSearch sets diagnostics', async () => {
      mockPost.mockResolvedValueOnce(ok({ ...VALIDATION_ERROR, data: { jobSearch: null } }));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('bad_input');
      expect(diagnostics?.detail).toContain('GraphQL');
    });

    it('a 200 with no data at all is unknown', async () => {
      mockPost.mockResolvedValueOnce(ok({}));

      const { diagnostics } = await service.scrape(input());

      expect(diagnostics).toEqual(expect.objectContaining({ reason: 'unknown' }));
    });

    it('keeps page-1 jobs when page 2 is blocked', async () => {
      mockPost.mockResolvedValueOnce(ok(PAGE1)).mockRejectedValueOnce(httpError(403, WAF_BLOCK_HTML));

      const { jobs, diagnostics } = await service.scrape(input({ resultsWanted: 20 }));

      expect(jobs).toHaveLength(4);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('GraphQL errors next to usable data are logged, not reported, when jobs come back', async () => {
      const page = lastPage1() as Record<string, unknown>;
      page.errors = [{ message: 'Field "relatedJobs" is deprecated' }];
      mockPost.mockResolvedValueOnce(ok(page));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toHaveLength(4);
      expect(diagnostics).toBeUndefined();
    });

    it('GraphQL errors next to an empty result are reported', async () => {
      mockPost.mockResolvedValueOnce(
        ok({
          errors: [{ message: 'Search backend unavailable' }],
          data: { jobSearch: { pageInfo: { nextCursor: null }, results: [] } },
        }),
      );

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics).toEqual(
        expect.objectContaining({ reason: 'unknown', detail: 'GraphQL: Search backend unavailable' }),
      );
    });

    it('a legitimately empty result carries no diagnostics', async () => {
      mockPost.mockResolvedValueOnce(ok({ data: { jobSearch: { pageInfo: { nextCursor: null }, results: [] } } }));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics).toBeUndefined();
    });

    it('a page on which every job fails to map is reported', async () => {
      const page = lastPage1() as typeof PAGE1;
      for (const result of page.data.jobSearch.results) {
        // `locations.join` throws on a string.
        result.job.employer = { name: 'X', companyProfile: { locations: 'not-an-array' } };
      }
      mockPost.mockResolvedValueOnce(ok(page));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('unknown');
      expect(diagnostics?.detail).toMatch(/^every job on page 1 failed to map: /);
    });

    it('one bad job among good ones is skipped without diagnostics', async () => {
      const page = lastPage1() as typeof PAGE1;
      page.data.jobSearch.results[0].job.employer = { name: 'X', companyProfile: { locations: 'nope' } };
      mockPost.mockResolvedValueOnce(ok(page));

      const { jobs, diagnostics } = await service.scrape(input());

      expect(jobs).toHaveLength(3);
      expect(diagnostics).toBeUndefined();
    });
  });
});
