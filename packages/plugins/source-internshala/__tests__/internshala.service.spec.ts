import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  DatePostedBasis,
  DescriptionFormat,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockSleep = jest.fn((_min: number, _max: number) => Promise.resolve());
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, setHeaders: mockSetHeaders })),
    randomSleep: (min: number, max: number) => mockSleep(min, max),
  };
});

import { createHttpClient } from '@ever-jobs/common';
import { InternshalaModule } from '../src/internshala.module';
import { InternshalaService } from '../src/internshala.service';
import { INTERNSHALA_DEFAULT_USER_AGENT } from '../src/internshala.constants';
import { hashCode } from '../src/internshala.parser';

/**
 * Spec 1706 — `InternshalaService` orchestration (S1–S9): streams, paging and
 * its stop rules, the canonical guard, client filters, detail budget,
 * diagnostics and the HTTP client options. The HTTP client is mocked and
 * routed by URL; fixtures are synthetic.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const JOBS_P1 = fixture('jobs-page1.html');
const JOBS_P2_LAST = fixture('jobs-page2-last.html');
const INTERNSHIPS_P1 = fixture('internships-page1.html');
const EMPTY = fixture('empty-page.html');
const ROOT_FEED = fixture('root-feed.html');
const DETAIL = fixture('detail.html');
const CHALLENGE = fixture('challenge.html');

const BASE = 'https://internshala.com';
const NOW = Date.UTC(2026, 8, 24, 19, 46, 34);

const noPagination = (html: string): string => html.replace(/<nav[\s\S]*<\/nav>/, '');

type Route = string | Error | (() => unknown);

/** Route `client.get(url)` by exact URL; any other URL is a test failure. */
function route(routes: Record<string, Route>, detail: Route = DETAIL): void {
  mockGet.mockImplementation(async (url: string) => {
    let hit = routes[url];
    if (hit === undefined && /\/(?:job|internship)\/detail\//.test(url)) hit = detail;
    if (hit === undefined) throw new Error(`unexpected URL in test: ${url}`);
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'function') return hit();
    return { data: hit };
  });
}

function httpError(status: number): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & { response?: { status: number } };
  err.response = { status };
  return err;
}

/** A page of `count` fresh cards (unique ids per call) with no pagination and no last-page flag. */
function endlessPage(kind: 'job' | 'internship', counter: { n: number }, count = 2): string {
  const cards: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = 5_000_000 + counter.n++;
    cards.push(
      `<div class="container-fluid individual_internship" internshipId="${id}" employment_type="${kind}">` +
        `<div class="internship_meta"><h2 class="job-internship-name"><a class="job-title-href" href="/${kind}/detail/role-${id}">Role ${id}</a></h2>` +
        `<p class="company-name">Company ${id}</p></div></div>`,
    );
  }
  return `<html><body>${cards.join('')}</body></html>`;
}

const requestedUrls = (): string[] => mockGet.mock.calls.map((c) => c[0] as string);
const detailUrls = (): string[] => requestedUrls().filter((u) => /\/(?:job|internship)\/detail\//.test(u));

async function scrape(input: Partial<ScraperInputDto>): Promise<JobResponseDto> {
  const service = new InternshalaService();
  return service.scrape({ siteType: [Site.INTERNSHALA], ...input } as ScraperInputDto);
}

const ENV_KEYS = ['INTERNSHALA_DEFAULT_STREAMS', 'INTERNSHALA_ID_SCHEME', 'INTERNSHALA_MAX_PAGES', 'INTERNSHALA_SLUG_TIMESTAMP'];

describe('InternshalaService — Spec 1706', () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockSleep.mockClear();
    (createHttpClient as jest.Mock).mockClear();
    for (const key of ENV_KEYS) delete process.env[key];
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('S9 registration', () => {
    it('resolves through InternshalaModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [InternshalaModule] }).compile();
      expect(moduleRef.get(InternshalaService)).toBeInstanceOf(InternshalaService);
      await moduleRef.close();
    });
  });

  describe('S1 default search', () => {
    it('fetches one page per stream and alternates internships and jobs', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 6, descriptionDepth: 'board' });

      expect(requestedUrls()).toEqual([`${BASE}/internships/keywords-python/`, `${BASE}/jobs/keywords-python/`]);
      expect(res.jobs.map((j) => j.listingType)).toEqual(['internship', 'job', 'internship', 'job', 'internship', 'job']);
      expect(res.jobs.map((j) => j.id)).toEqual([
        'is-3200001',
        'is-3100001',
        'is-3200002',
        'is-3100002',
        'is-3200003',
        'is-3100003',
      ]);
      expect(new Set(res.jobs.map((j) => j.id)).size).toBe(6);
      expect(detailUrls()).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      // one pause, between the two requests, in the 2-5 s band
      expect(mockSleep).toHaveBeenCalledTimes(1);
      expect(mockSleep).toHaveBeenCalledWith(2000, 5000);
    });

    it('maps structured fields onto the DTO', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 10, descriptionDepth: 'board' });
      const net = res.jobs.find((j) => j.id === 'is-3100001')!;
      expect(net).toMatchObject({
        title: 'Network Administrator',
        companyName: 'Acme Learning Group',
        jobType: [JobType.FULL_TIME],
        compensation: { minAmount: 200000, maxAmount: 260000, interval: 'yearly', currency: 'INR' },
        datePosted: '2026-09-21',
        datePostedBasis: DatePostedBasis.TIMESTAMP,
        skills: ['Python', 'DNS', 'Linux'],
        experienceRange: '1 year(s)',
        isRemote: false,
      });
      expect(net.description).toMatch(/^Key Responsibilities:\n1\. Keep the campus network running\./);
      const ai = res.jobs.find((j) => j.id === 'is-3200001')!;
      expect(ai).toMatchObject({ isRemote: true, workFromHomeType: 'Remote', jobType: [JobType.INTERNSHIP, JobType.PART_TIME] });
      expect(ai.compensation).toBeNull();
    });
  });

  describe('S2 jobType', () => {
    it('INTERNSHIP requests only the internship stream', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/internships/keywords-python/page-2/`]: EMPTY,
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.INTERNSHIP, descriptionDepth: 'board' });
      expect(requestedUrls().every((u) => u.startsWith(`${BASE}/internships/`))).toBe(true);
      expect(res.jobs).toHaveLength(5);
      expect(res.jobs.every((j) => j.listingType === 'internship')).toBe(true);
    });

    it('FULL_TIME requests only jobs and drops "Part time" ones', async () => {
      route({
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, descriptionDepth: 'board' });
      expect(requestedUrls().every((u) => u.startsWith(`${BASE}/jobs/`))).toBe(true);
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3100001', 'is-3100002', 'is-3100003', 'is-3100004']);
    });

    it('PART_TIME runs both streams and keeps only "Part time" postings', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/internships/keywords-python/page-2/`]: EMPTY,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.PART_TIME, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3200001', 'is-3100005']);
      expect(res.jobs.every((j) => j.jobType?.includes(JobType.PART_TIME))).toBe(true);
    });

    it('CONTRACT makes no request and explains the empty result', async () => {
      const res = await scrape({ searchTerm: 'python', jobType: JobType.CONTRACT });
      expect(mockGet).not.toHaveBeenCalled();
      expect(createHttpClient).not.toHaveBeenCalled();
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('empty');
      expect(res.diagnostics?.detail).toContain('jobType=contract has no equivalent');
    });

    it('INTERNSHALA_DEFAULT_STREAMS=job restores the jobs-only default', async () => {
      process.env.INTERNSHALA_DEFAULT_STREAMS = 'job';
      route({
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', descriptionDepth: 'board' });
      expect(requestedUrls()).toEqual([`${BASE}/jobs/keywords-python/`, `${BASE}/jobs/keywords-python/page-2/`]);
      expect(res.jobs.every((j) => j.listingType === 'job')).toBe(true);
    });
  });

  describe('S3 pagination stops', () => {
    it('stops on isLastPage=1 and never repeats a posting', async () => {
      process.env.INTERNSHALA_DEFAULT_STREAMS = 'job';
      route({
        [`${BASE}/jobs/keywords-python/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 100, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(2);
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3100001', 'is-3100002', 'is-3100003', 'is-3100004', 'is-3100005']);
    });

    it('stops at the highest pagination page', async () => {
      route({
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P1.replace(/internshipId="31/g, 'internshipId="41'),
      });
      await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, resultsWanted: 100, descriptionDepth: 'board' });
      expect(requestedUrls()).toEqual([`${BASE}/jobs/keywords-python/`, `${BASE}/jobs/keywords-python/page-2/`]);
    });

    it('stops on a page with no new ids', async () => {
      route({
        [`${BASE}/jobs/keywords-python/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/keywords-python/page-2/`]: noPagination(JOBS_P1),
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, resultsWanted: 100, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(2);
      expect(res.jobs).toHaveLength(4);
    });

    it('stops on an empty page', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: noPagination(INTERNSHIPS_P1),
        [`${BASE}/internships/keywords-python/page-2/`]: EMPTY,
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.INTERNSHIP, resultsWanted: 100, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(2);
      expect(res.jobs).toHaveLength(5);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a later page that is gone (404) or answered with the root ends the stream without a diagnostic', async () => {
      route({
        [`${BASE}/jobs/keywords-python/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/keywords-python/page-2/`]: httpError(404),
      });
      let res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, resultsWanted: 100, descriptionDepth: 'board' });
      expect(res.jobs).toHaveLength(4);
      expect(res.diagnostics).toBeUndefined();

      mockGet.mockReset();
      route({
        [`${BASE}/jobs/keywords-python/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/keywords-python/page-2/`]: ROOT_FEED,
      });
      res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, resultsWanted: 100, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(2);
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3100001', 'is-3100002', 'is-3100003', 'is-3100004']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a 404 on page 1 of the keyword search is reported', async () => {
      route({ [`${BASE}/jobs/keywords-python/`]: httpError(404) });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, descriptionDepth: 'board' });
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
    });

    it('never exceeds the page cap (10 per stream, or INTERNSHALA_MAX_PAGES)', async () => {
      const counter = { n: 0 };
      mockGet.mockImplementation(async (url: string) => ({
        data: endlessPage(url.includes('/internships/') ? 'internship' : 'job', counter),
      }));
      const res = await scrape({ searchTerm: 'python', resultsWanted: 1000, descriptionDepth: 'board' });
      const urls = requestedUrls();
      expect(urls.filter((u) => u.includes('/internships/'))).toHaveLength(10);
      expect(urls.filter((u) => u.includes('/jobs/'))).toHaveLength(10);
      expect(urls).toContain(`${BASE}/jobs/keywords-python/page-10/`);
      expect(urls).not.toContain(`${BASE}/jobs/keywords-python/page-11/`);
      expect(res.jobs).toHaveLength(40);

      mockGet.mockClear();
      process.env.INTERNSHALA_MAX_PAGES = '3';
      await scrape({ searchTerm: 'python', resultsWanted: 1000, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(6);
    });

    it('stops as soon as a round has enough postings', async () => {
      const counter = { n: 0 };
      mockGet.mockImplementation(async (url: string) => ({
        data: endlessPage(url.includes('/internships/') ? 'internship' : 'job', counter, 3),
      }));
      const res = await scrape({ searchTerm: 'python', resultsWanted: 10, descriptionDepth: 'board' });
      // rounds of 3 + 3: 6 after round 1, 12 after round 2
      expect(requestedUrls()).toHaveLength(4);
      expect(res.jobs).toHaveLength(10);
    });
  });

  describe('S4 canonical guard', () => {
    it('discards an unfiltered root page and retries the stream with the keyword search', async () => {
      route({
        [`${BASE}/jobs/python-jobs-in-bangalore/`]: ROOT_FEED,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({
        searchTerm: 'python',
        location: 'Bangalore',
        jobType: JobType.FULL_TIME,
        descriptionDepth: 'board',
      });
      expect(requestedUrls()).toEqual([
        `${BASE}/jobs/python-jobs-in-bangalore/`,
        `${BASE}/jobs/keywords-python/`,
        `${BASE}/jobs/keywords-python/page-2/`,
      ]);
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3100003']);
      expect(res.jobs[0].location?.city).toBe('Bangalore');
      expect(res.diagnostics).toBeUndefined();
    });

    it('also detects the drop from the final response URL', async () => {
      route({
        [`${BASE}/jobs/jobs-in-bangalore/`]: () => ({
          data: ROOT_FEED.replace(/<link rel='canonical'[^>]*>/, ''),
          request: { res: { responseUrl: `${BASE}/jobs/` } },
        }),
        [`${BASE}/jobs/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/page-2/`]: EMPTY,
      });
      const res = await scrape({ location: 'Bengaluru', jobType: JobType.FULL_TIME, descriptionDepth: 'board' });
      expect(requestedUrls()[1]).toBe(`${BASE}/jobs/`);
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3100003']);
    });

    it('a 404 on a narrow path falls back to the keyword search without a diagnostic', async () => {
      route({
        [`${BASE}/internships/work-from-home-python-internships/`]: httpError(404),
        [`${BASE}/internships/keywords-python/`]: noPagination(INTERNSHIPS_P1),
        [`${BASE}/internships/keywords-python/page-2/`]: EMPTY,
      });
      const res = await scrape({
        searchTerm: 'python',
        isRemote: true,
        jobType: JobType.INTERNSHIP,
        descriptionDepth: 'board',
      });
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3200001', 'is-3200002']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('stops the stream with fetch_error when the keyword search itself is dropped', async () => {
      route({ [`${BASE}/jobs/keywords-python/`]: ROOT_FEED });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, descriptionDepth: 'board' });
      expect(requestedUrls()).toHaveLength(1);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toEqual({
        reason: 'fetch_error',
        detail: 'internshala dropped the search filter (redirected to /jobs/)',
      });
    });
  });

  describe('S5 client filters', () => {
    it('isRemote keeps only work-from-home postings', async () => {
      route({
        [`${BASE}/internships/work-from-home-python-internships/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/work-from-home-python-jobs/`]: JOBS_P1,
        [`${BASE}/internships/work-from-home-python-internships/page-2/`]: EMPTY,
        [`${BASE}/jobs/work-from-home-python-jobs/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', isRemote: true, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3200001', 'is-3100004', 'is-3200002']);
      expect(res.jobs.every((j) => j.isRemote)).toBe(true);
    });

    it('hoursOld drops postings older than the window', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/internships/keywords-python/page-2/`]: EMPTY,
        [`${BASE}/jobs/keywords-python/page-2/`]: JOBS_P2_LAST,
      });
      const res = await scrape({ searchTerm: 'python', hoursOld: 48, descriptionDepth: 'board' });
      const ids = res.jobs.map((j) => j.id);
      expect(ids).not.toContain('is-3100001'); // 3 days ago
      expect(ids).not.toContain('is-3100002'); // 1 week ago
      expect(ids).not.toContain('is-3200005'); // 1 week ago
      expect(ids).not.toContain('is-3100005'); // 2 weeks ago
      expect(ids).toEqual(expect.arrayContaining(['is-3100003', 'is-3100004', 'is-3200001', 'is-3200004']));
    });

    it('offset skips the first merged postings', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 3, offset: 2, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(['is-3200002', 'is-3100002', 'is-3200003']);
    });
  });

  describe('S6 detail pages', () => {
    it('fetches details sequentially for the selected postings (default depth)', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 3 });
      expect(detailUrls()).toEqual([
        `${BASE}/internship/detail/work-from-home-ai-research-internship-at-lumen-foundation1790260000`,
        `${BASE}/job/detail/network-administrator-job-in-lucknow-at-acme-learning-group1789994794`,
        `${BASE}/internship/detail/work-from-home-embedded-systems-internship-at-copperleaf-devices1790275000`,
      ]);
      // every request after the first is preceded by a pause
      expect(mockSleep).toHaveBeenCalledTimes(requestedUrls().length - 1);
      expect(res.jobs[1].description).toMatch(/^Acme Learning Group runs twelve campuses/);
      expect(res.jobs[1].description).toMatch(/\n\nSalary: ₹ 2,00,000 - 2,60,000 \/year \| Experience: 1 year\(s\)$/);
      expect(res.jobs[1].emails).toEqual(['jobs@acme-learning.example']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a failed detail keeps the snippet and records a diagnostic', async () => {
      route(
        {
          [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
          [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
          [`${BASE}/job/detail/network-administrator-job-in-lucknow-at-acme-learning-group1789994794`]: new Error(
            'timeout of 60000ms exceeded',
          ),
        },
        DETAIL,
      );
      const res = await scrape({ searchTerm: 'python', resultsWanted: 3 });
      expect(res.jobs).toHaveLength(3);
      expect(res.jobs[1].description).toMatch(/^Key Responsibilities:/);
      expect(res.jobs[0].description).toMatch(/^Acme Learning Group runs twelve campuses/);
      expect(res.jobs[2].description).toMatch(/^Acme Learning Group runs twelve campuses/);
      expect(res.diagnostics?.reason).toBe('timeout');
    });

    it('caps detail requests at 25 by default and honours detail-all and PLAIN', async () => {
      const counter = { n: 0 };
      mockGet.mockImplementation(async (url: string) => {
        if (/\/(?:job|internship)\/detail\//.test(url)) return { data: DETAIL };
        return { data: endlessPage(url.includes('/internships/') ? 'internship' : 'job', counter, 20) };
      });
      await scrape({ searchTerm: 'python', resultsWanted: 30 });
      expect(detailUrls()).toHaveLength(25);

      mockGet.mockClear();
      const res = await scrape({
        searchTerm: 'python',
        resultsWanted: 30,
        descriptionDepth: 'detail-all',
        descriptionFormat: DescriptionFormat.PLAIN,
      });
      expect(detailUrls()).toHaveLength(30);
      expect(res.jobs[0].description).not.toMatch(/^\s*[*-]\s/m);
      expect(res.jobs[0].description).toContain('Keep the campus network running');
    });

    it('caps detail-all at a finite ceiling', async () => {
      const counter = { n: 0 };
      mockGet.mockImplementation(async (url: string) => {
        if (/\/(?:job|internship)\/detail\//.test(url)) return { data: DETAIL };
        return { data: endlessPage(url.includes('/internships/') ? 'internship' : 'job', counter, 40) };
      });
      await scrape({ searchTerm: 'python', resultsWanted: 500, descriptionDepth: 'detail-all' });
      expect(detailUrls()).toHaveLength(100);
    });

    it.each([
      [403, 'blocked'],
      [429, 'fetch_error'],
    ])('stops detail requests at the first %p and keeps the snippets', async (status, reason) => {
      route(
        {
          [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
          [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        },
        httpError(status),
      );
      const res = await scrape({ searchTerm: 'python', resultsWanted: 3 });
      expect(detailUrls()).toHaveLength(1);
      expect(res.jobs).toHaveLength(3);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it('stops detail requests at a challenge page', async () => {
      route(
        {
          [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
          [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        },
        '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>',
      );
      const res = await scrape({ searchTerm: 'python', resultsWanted: 3 });
      expect(detailUrls()).toHaveLength(1);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('stops after three failed detail requests in a row', async () => {
      const counter = { n: 0 };
      mockGet.mockImplementation(async (url: string) => {
        if (/\/(?:job|internship)\/detail\//.test(url)) throw httpError(502);
        return { data: endlessPage(url.includes('/internships/') ? 'internship' : 'job', counter, 20) };
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 10 });
      expect(detailUrls()).toHaveLength(3);
      expect(res.jobs).toHaveLength(10);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });
  });

  describe('S7 errors and diagnostics', () => {
    it('a 403 on page 1 of both streams is reported as blocked, not empty', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: httpError(403),
        [`${BASE}/jobs/keywords-python/`]: httpError(403),
      });
      const res = await scrape({ searchTerm: 'python' });
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('a failure after page 1 keeps the page-1 postings and the diagnostic', async () => {
      route({
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
        [`${BASE}/jobs/keywords-python/page-2/`]: httpError(503),
      });
      const res = await scrape({ searchTerm: 'python', jobType: JobType.FULL_TIME, descriptionDepth: 'board' });
      expect(res.jobs).toHaveLength(4);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('one failed stream does not stop the other', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: httpError(500),
        [`${BASE}/jobs/keywords-python/`]: noPagination(JOBS_P1),
        [`${BASE}/jobs/keywords-python/page-2/`]: EMPTY,
      });
      const res = await scrape({ searchTerm: 'python', descriptionDepth: 'board' });
      expect(res.jobs).toHaveLength(4);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a challenge page is reported as blocked', async () => {
      route({ [`${BASE}/internships/`]: CHALLENGE });
      const res = await scrape({ jobType: JobType.INTERNSHIP });
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('no cards and no error leaves diagnostics unset (reported upstream as empty)', async () => {
      route({ [`${BASE}/internships/keywords-zzz/`]: EMPTY, [`${BASE}/jobs/keywords-zzz/`]: EMPTY });
      const res = await scrape({ searchTerm: 'zzz' });
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });
  });

  describe('S8 HTTP client', () => {
    it('passes the caller UA and transport options; no user-agent header override', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      await scrape({
        searchTerm: 'python',
        resultsWanted: 1,
        descriptionDepth: 'board',
        userAgent: 'CallerBot/2.0',
        requestTimeout: 20,
        proxies: ['http://proxy.local:8080'],
      });
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'CallerBot/2.0',
          requestTimeout: 20,
          proxies: ['http://proxy.local:8080'],
          allowedRedirectHosts: ['internshala.com'],
        }),
      );
      expect(mockSetHeaders).toHaveBeenCalledTimes(1);
      const headers = mockSetHeaders.mock.calls[0][0] as Record<string, string>;
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
      expect(Object.keys(headers).some((k) => /^sec-/i.test(k))).toBe(false);
    });

    it('defaults to the honest identifying UA', async () => {
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      await scrape({ searchTerm: 'python', resultsWanted: 1, descriptionDepth: 'board' });
      expect(createHttpClient).toHaveBeenCalledWith(expect.objectContaining({ userAgent: INTERNSHALA_DEFAULT_USER_AGENT }));
      expect(INTERNSHALA_DEFAULT_USER_AGENT).toMatch(/compatible; EverJobs/);
    });
  });

  describe('legacy switches', () => {
    it('INTERNSHALA_ID_SCHEME=url-hash emits the pre-Spec-1706 ids', async () => {
      process.env.INTERNSHALA_ID_SCHEME = 'url-hash';
      route({
        [`${BASE}/internships/keywords-python/`]: INTERNSHIPS_P1,
        [`${BASE}/jobs/keywords-python/`]: JOBS_P1,
      });
      const res = await scrape({ searchTerm: 'python', resultsWanted: 2, descriptionDepth: 'board' });
      expect(res.jobs.map((j) => j.id)).toEqual(res.jobs.map((j) => `is-${Math.abs(hashCode(j.jobUrl))}`));
    });
  });
});
