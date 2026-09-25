import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatePostedPrecision, JobPostDto, JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
  };
});
jest.mock('../src/simplifyjobs.mapper', () => {
  const actual = jest.requireActual('../src/simplifyjobs.mapper');
  return { ...actual, mapRowToJobPost: jest.fn(actual.mapRowToJobPost) };
});

import { createHttpClient } from '@ever-jobs/common';
import { SimplifyJobsModule, SimplifyJobsService } from '@ever-jobs/source-simplifyjobs';
import {
  SIMPLIFYJOBS_ROBOTS_URL,
  SIMPLIFYJOBS_SITE,
  SIMPLIFYJOBS_USER_AGENT,
} from '../src/simplifyjobs.constants';
import * as mapper from '../src/simplifyjobs.mapper';
import { SIMPLIFYJOBS_CLOCK } from '../src/simplifyjobs.service';

const SITE: Site = Site.SIMPLIFYJOBS;

const FIXTURES = path.join(__dirname, 'fixtures');
const NEWGRAD = fs.readFileSync(path.join(FIXTURES, 'newgrad-listings.json'), 'utf8');
const INTERNSHIPS = fs.readFileSync(path.join(FIXTURES, 'internships-listings.json'), 'utf8');

const NEWGRAD_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json';
const INTERNSHIPS_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';

const NOW_MS = 1790280000 * 1000; // 2026-09-24T20:00:00Z

type Response = { status: number; headers: Record<string, string>; data: unknown };
type Handler = (config: Record<string, unknown>) => Promise<Response> | Response;

const ok = (data: unknown, etag = '"v1"', cacheControl = 'max-age=300'): Response => ({
  status: 200,
  headers: { etag, 'cache-control': cacheControl, 'content-type': 'text/plain; charset=utf-8' },
  data,
});
const notModified = (cacheControl = 'max-age=300'): Response => ({ status: 304, headers: { 'cache-control': cacheControl }, data: Buffer.alloc(0) });
const httpError = (status: number): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

let handlers: { robots: Handler; newgrad: Handler; internships: Handler };
let clock = NOW_MS;

function route(url: string): keyof typeof handlers {
  if (url === SIMPLIFYJOBS_ROBOTS_URL) return 'robots';
  if (url.includes('Internships')) return 'internships';
  if (url.includes('New-Grad')) return 'newgrad';
  throw new Error(`unexpected url ${url}`);
}

function feedCalls(): Array<[string, Record<string, unknown>]> {
  return mockGet.mock.calls.filter(([url]) => url !== SIMPLIFYJOBS_ROBOTS_URL) as Array<[string, Record<string, unknown>]>;
}

function input(partial: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ siteType: [SITE], resultsWanted: 100, ...partial });
}

const ids = (jobs: JobPostDto[]): string[] => jobs.map((j) => (j.id ?? '').slice(-3));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function newService(): SimplifyJobsService {
  return new SimplifyJobsService(() => clock);
}

const ENV_KEYS = ['SIMPLIFYJOBS_NEWGRAD_REPO', 'SIMPLIFYJOBS_INTERNSHIPS_REPO', 'SIMPLIFYJOBS_BRANCH'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  clock = NOW_MS;
  mockGet.mockReset();
  (createHttpClient as jest.Mock).mockClear();
  (mapper.mapRowToJobPost as jest.Mock).mockClear();
  handlers = {
    robots: () => ({ status: 404, headers: {}, data: 'Not Found' }),
    newgrad: () => ok(NEWGRAD, '"ng1"'),
    internships: () => ok(INTERNSHIPS, '"in1"'),
  };
  mockGet.mockImplementation(async (url: string, config: Record<string, unknown>) => handlers[route(url)](config));
});

describe('SimplifyJobsService (Spec 1694)', () => {
  describe('module', () => {
    it('registers under Site.SIMPLIFYJOBS', () => {
      expect(SIMPLIFYJOBS_SITE).toBe(Site.SIMPLIFYJOBS);
      expect(Site.SIMPLIFYJOBS).toBe('simplifyjobs');
    });

    it('resolves through Nest DI without a clock provider', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SimplifyJobsModule] }).compile();
      const service = moduleRef.get(SimplifyJobsService);
      expect(service).toBeInstanceOf(SimplifyJobsService);
      const res = await service.scrape(input({ jobType: JobType.INTERNSHIP, resultsWanted: 1 }));
      expect(res.jobs).toHaveLength(1);
    });

    it('uses an injected clock', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [SimplifyJobsService, { provide: SIMPLIFYJOBS_CLOCK, useValue: () => NOW_MS }],
      }).compile();
      const res = await moduleRef.get(SimplifyJobsService).scrape(input({ jobType: JobType.INTERNSHIP, hoursOld: 3 }));
      expect(ids(res.jobs)).toEqual(['203', '201']);
    });
  });

  describe('mapping', () => {
    it('maps a new-grad row', async () => {
      const res = await newService().scrape(input({ jobType: JobType.FULL_TIME }));
      const job = res.jobs.find((j) => j.id?.endsWith('101'));
      expect(job).toMatchObject({
        id: 'simplifyjobs-00000000-0000-4000-8000-000000000101',
        site: SITE,
        title: 'Software Engineer, New Grad',
        companyName: 'Acme Robotics',
        companyUrl: 'https://simplify.jobs/c/Acme-Robotics',
        jobUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/1001',
        jobUrlDirect: 'https://boards.greenhouse.io/acmerobotics/jobs/1001',
        applyUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/1001',
        datePosted: '2026-09-24',
        datePostedAt: '2026-09-24T17:00:00.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
        jobType: [JobType.FULL_TIME],
        jobLevel: 'Entry level',
        employmentType: 'Full-time (new grad)',
        jobFunction: 'Software',
        atsType: 'greenhouse',
        description: null,
      });
    });

    it('maps an internship row with a midnight-aligned date and strips N/A terms', async () => {
      const res = await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      const summer = res.jobs.find((j) => j.id?.endsWith('201'));
      expect(summer).toMatchObject({
        datePosted: '2026-09-24',
        datePostedPrecision: DatePostedPrecision.DAY,
        jobType: [JobType.INTERNSHIP, JobType.SUMMER],
        jobLevel: 'Internship',
        employmentType: 'Internship · Summer 2027',
        atsType: 'greenhouse',
      });
      expect(summer?.datePostedAt).toBeUndefined();
      const na = res.jobs.find((j) => j.id?.endsWith('202'));
      expect(na).toMatchObject({ employmentType: 'Internship', jobFunction: 'Quant', atsType: 'ashby', jobType: [JobType.INTERNSHIP] });
      const multi = res.jobs.find((j) => j.id?.endsWith('203'));
      expect(multi?.employmentType).toBe('Internship · Winter 2027, Spring 2027');
    });

    it('normalises categories and detects ATS hosts', async () => {
      const res = await newService().scrape(input({ jobType: JobType.FULL_TIME }));
      const byId = new Map(res.jobs.map((j) => [(j.id ?? '').slice(-3), j]));
      expect(byId.get('103')).toMatchObject({ jobFunction: 'AI/ML/Data', atsType: 'lever' });
      expect(byId.get('104')).toMatchObject({ jobFunction: 'Quant', atsType: 'oracle' });
      expect(byId.get('102')).toMatchObject({ jobFunction: 'Hardware', atsType: 'workday' });
      expect(byId.get('107')?.atsType).toBe('icims');
      expect(byId.get('109')?.atsType).toBe('greenhouse');
      expect(byId.get('110')?.atsType).toBe('taleo');
    });
  });

  describe('row filtering', () => {
    it('drops inactive, hidden, link-less, untitled and company-less rows; keeps a missing is_visible', async () => {
      const res = await newService().scrape(input());
      const got = ids(res.jobs);
      for (const dropped of ['111', '112', '113', '116', '117', '207']) expect(got).not.toContain(dropped);
      expect(got).toContain('110');
    });
  });

  describe('locations', () => {
    let byId: Map<string, JobPostDto>;
    beforeEach(async () => {
      const res = await newService().scrape(input());
      byId = new Map(res.jobs.map((j) => [(j.id ?? '').slice(-3), j]));
    });

    it('tells Cambridge UK from Cambridge MA and Birmingham AL from Birmingham UK', () => {
      expect(byId.get('101')?.location).toMatchObject({ city: 'Cambridge', country: 'United Kingdom' });
      expect(byId.get('102')?.location).toMatchObject({ city: 'Cambridge', state: 'MA' });
      expect(byId.get('103')?.location).toMatchObject({ city: 'Birmingham', state: 'AL' });
      expect(byId.get('104')?.location).toMatchObject({ city: 'Birmingham', country: 'United Kingdom' });
    });

    it('expands NYC and SF', () => {
      expect(byId.get('105')?.location).toMatchObject({ city: 'New York', state: 'NY', text: 'NYC' });
      expect(byId.get('106')?.location).toMatchObject({ city: 'San Francisco', state: 'CA', text: 'SF' });
    });

    it('reads Remote in USA as remote in the United States', () => {
      expect(byId.get('107')).toMatchObject({ isRemote: true, location: { country: 'United States' } });
    });

    it('keeps the state of multi-part labels', () => {
      expect(byId.get('108')?.location).toMatchObject({ city: 'Ottawa', state: 'ON', country: 'Canada' });
      expect(byId.get('109')?.location).toMatchObject({ city: 'Durham', state: 'NC' });
    });

    it('keeps one entry per site for a multi-location row', () => {
      expect(byId.get('110')?.locations).toHaveLength(3);
      expect(byId.get('110')?.isRemote).toBe(true);
    });
  });

  describe('searchTerm', () => {
    it('ANDs tokens across title, company, category and terms', async () => {
      const svc = newService();
      expect(ids((await svc.scrape(input({ searchTerm: 'software intern' }))).jobs)).toEqual(['201', '208']);
      expect(ids((await svc.scrape(input({ searchTerm: 'quant' }))).jobs)).toEqual(['104', '202']);
      expect(ids((await svc.scrape(input({ searchTerm: 'summer 2028' }))).jobs)).toEqual(['208']);
      expect(ids((await svc.scrape(input({ searchTerm: 'HOOLI' }))).jobs)).toEqual(['105', '208']);
    });

    it('folds accents both ways', async () => {
      const svc = newService();
      expect(ids((await svc.scrape(input({ searchTerm: 'cafe developpeur' }))).jobs)).toEqual(['119']);
      expect(ids((await svc.scrape(input({ searchTerm: 'Café' }))).jobs)).toEqual(['119']);
    });
  });

  describe('location filter', () => {
    it.each([
      ['New York', ['105', '208']],
      ['United Kingdom', ['203', '101', '104']],
      ['Canada', ['201', '108', '119', '202']],
      ['Remote', ['107', '110', '206']],
    ])('%s', async (location, expected) => {
      const res = await newService().scrape(input({ location }));
      expect(ids(res.jobs)).toEqual(expected);
    });

    it('does not treat the input country default (USA) as a filter', async () => {
      const res = await newService().scrape(new ScraperInputDto({ siteType: [SITE], resultsWanted: 100 }));
      expect(ids(res.jobs)).toEqual(expect.arrayContaining(['101', '104', '203', '201', '209', '210']));
    });
  });

  describe('isRemote', () => {
    it('keeps only remote rows when true, and does not filter when false (the default)', async () => {
      const svc = newService();
      expect(ids((await svc.scrape(input({ isRemote: true }))).jobs)).toEqual(['107', '110', '206']);
      expect((await svc.scrape(input({ isRemote: false }))).jobs).toHaveLength(21);
    });
  });

  describe('hoursOld', () => {
    it('keeps a row posted exactly at the cut-off, drops one a second older, and applies the midnight rule', async () => {
      const res = await newService().scrape(input({ hoursOld: 3 }));
      // 203: 1h23m old; 101: exactly 3h; 201: stamped 00:00 today (day-granular); 102: 3h + 1s
      expect(ids(res.jobs)).toEqual(['203', '101', '201']);
    });

    it('does not drop today’s midnight-stamped rows at 20:00 with hoursOld 12', async () => {
      const res = await newService().scrape(input({ hoursOld: 12, jobType: JobType.INTERNSHIP }));
      expect(ids(res.jobs)).toEqual(['203', '204', '201']);
    });
  });

  describe('jobType routing', () => {
    it('INTERNSHIP: one feed request, to the internships list', async () => {
      const res = await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(feedCalls().map(([url]) => url)).toEqual([INTERNSHIPS_URL]);
      expect(res.jobs.every((j) => j.jobType?.includes(JobType.INTERNSHIP))).toBe(true);
      expect(res.jobs).toHaveLength(9);
    });

    it('FULL_TIME: one feed request, to the new-grad list', async () => {
      const res = await newService().scrape(input({ jobType: JobType.FULL_TIME }));
      expect(feedCalls().map(([url]) => url)).toEqual([NEWGRAD_URL]);
      expect(res.jobs.every((j) => j.jobType?.[0] === JobType.FULL_TIME)).toBe(true);
    });

    it('SUMMER: internships with a summer term only', async () => {
      const res = await newService().scrape(input({ jobType: JobType.SUMMER }));
      expect(feedCalls().map(([url]) => url)).toEqual([INTERNSHIPS_URL]);
      expect(ids(res.jobs)).toEqual(['204', '201', '205', '210', '208']);
    });

    it.each([JobType.PART_TIME, JobType.CONTRACT, JobType.PERMANENT, JobType.APPRENTICESHIP])(
      '%s: no request at all and an empty diagnostic',
      async (jobType) => {
        const res = await newService().scrape(input({ jobType }));
        expect(res.jobs).toEqual([]);
        expect(res.diagnostics).toEqual({
          reason: 'empty',
          detail: 'simplifyjobs lists only full-time new-grad roles and internships',
        });
        expect(mockGet).not.toHaveBeenCalled();
        expect(createHttpClient).not.toHaveBeenCalled();
      },
    );

    it('unset: both lists, one after the other, merged newest first and deduped across lists', async () => {
      const order: string[] = [];
      let releaseNewgrad: () => void = () => undefined;
      handlers.newgrad = () =>
        new Promise<Response>((resolve) => {
          order.push('newgrad:start');
          releaseNewgrad = () => {
            order.push('newgrad:end');
            resolve(ok(NEWGRAD, '"ng1"'));
          };
        });
      handlers.internships = () => {
        order.push('internships:start');
        return ok(INTERNSHIPS, '"in1"');
      };

      const pending = newService().scrape(input());
      await flush();
      expect(order).toEqual(['newgrad:start']);
      releaseNewgrad();
      const res = await pending;
      expect(order).toEqual(['newgrad:start', 'newgrad:end', 'internships:start']);

      expect(ids(res.jobs)).toEqual([
        '203', '101', '102', '204', '103', '104', '105', '106', '107', '201',
        '108', '205', '109', '210', '110', '114', '119', '202', '206', '208', '209',
      ]);
      // same apply URL (host case + trailing slash differ): the newer internship row wins
      expect(ids(res.jobs)).not.toContain('118');
      // same URL twice in one list: the newer row wins
      expect(ids(res.jobs)).not.toContain('115');
      expect(res.diagnostics).toBeUndefined();
    });
  });

  describe('paging', () => {
    it('applies offset and resultsWanted after sorting', async () => {
      const svc = newService();
      const all = ids((await svc.scrape(input())).jobs);
      expect(ids((await svc.scrape(input({ offset: 2, resultsWanted: 3 }))).jobs)).toEqual(all.slice(2, 5));
      expect((await svc.scrape(input({ offset: 50 }))).jobs).toEqual([]);
    });

    it('uses the input default of 15 and clamps a huge resultsWanted', async () => {
      const svc = newService();
      expect((await svc.scrape(new ScraperInputDto({ siteType: [SITE] }))).jobs).toHaveLength(15);
      expect((await svc.scrape(input({ resultsWanted: 50_000 }))).jobs).toHaveLength(21);
    });
  });

  describe('cache', () => {
    it('makes no request for a second scrape within the TTL', async () => {
      const svc = newService();
      await svc.scrape(input());
      expect(feedCalls()).toHaveLength(2);
      clock += 299_000;
      await svc.scrape(input({ searchTerm: 'intern' }));
      expect(feedCalls()).toHaveLength(2);
    });

    it('revalidates with If-None-Match after the TTL and reuses the rows on 304', async () => {
      const svc = newService();
      const first = await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 301_000;
      handlers.internships = () => notModified();
      const second = await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      const [, config] = feedCalls()[1];
      expect((config.headers as Record<string, string>)['If-None-Match']).toBe('"in1"');
      expect(ids(second.jobs)).toEqual(ids(first.jobs));
      expect(second.diagnostics).toBeUndefined();
    });

    it('replaces the rows on a 200 with a new ETag', async () => {
      const svc = newService();
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 301_000;
      const smaller = JSON.stringify(JSON.parse(INTERNSHIPS).slice(0, 2));
      handlers.internships = () => ok(smaller, '"in2"');
      expect(ids((await svc.scrape(input({ jobType: JobType.INTERNSHIP }))).jobs)).toEqual(['203', '201']);
      clock += 301_000;
      handlers.internships = () => notModified();
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect((feedCalls()[2][1].headers as Record<string, string>)['If-None-Match']).toBe('"in2"');
    });

    it('honours max-age and clamps it', async () => {
      const svc = newService();
      handlers.internships = () => ok(INTERNSHIPS, '"in1"', 'max-age=900');
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 600_000;
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(feedCalls()).toHaveLength(1);

      const other = newService();
      handlers.newgrad = () => ok(NEWGRAD, '"ng1"', 'max-age=5');
      await other.scrape(input({ jobType: JobType.FULL_TIME }));
      clock += 30_000;
      await other.scrape(input({ jobType: JobType.FULL_TIME }));
      expect(feedCalls().filter(([url]) => url === NEWGRAD_URL)).toHaveLength(1);
    });

    it('reads robots.txt once per day, not per scrape', async () => {
      const svc = newService();
      await svc.scrape(input());
      clock += 301_000;
      handlers.newgrad = () => notModified();
      handlers.internships = () => notModified();
      await svc.scrape(input());
      expect(mockGet.mock.calls.filter(([url]) => url === SIMPLIFYJOBS_ROBOTS_URL)).toHaveLength(1);
    });

    it('shares one download per list between concurrent scrapes', async () => {
      const svc = newService();
      const [a, b] = await Promise.all([svc.scrape(input()), svc.scrape(input({ searchTerm: 'intern' }))]);
      expect(feedCalls().map(([url]) => url).sort()).toEqual([INTERNSHIPS_URL, NEWGRAD_URL].sort());
      expect(a.jobs).toHaveLength(21);
      expect(b.jobs.length).toBeGreaterThan(0);
    });
  });

  describe('errors', () => {
    it('serves the other list with a partial diagnostic when one list fails', async () => {
      handlers.newgrad = () => {
        throw httpError(500);
      };
      const res = await newService().scrape(input());
      expect(res.jobs).toHaveLength(9);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('newgrad: fetch_error: Request failed with status code 500');
    });

    it('classifies the error when every list fails', async () => {
      handlers.newgrad = () => {
        throw httpError(502);
      };
      handlers.internships = () => {
        throw httpError(503);
      };
      const res = await newService().scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(res.diagnostics?.detail).toMatch(/newgrad: .*502.*; internships: .*503/);
    });

    it('classifies a timeout and a block', async () => {
      handlers.internships = () => {
        throw Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' });
      };
      expect((await newService().scrape(input({ jobType: JobType.INTERNSHIP }))).diagnostics?.reason).toBe('timeout');
      handlers.internships = () => {
        throw httpError(403);
      };
      expect((await newService().scrape(input({ jobType: JobType.INTERNSHIP }))).diagnostics?.reason).toBe('blocked');
    });

    it.each([
      ['a non-array body', '{"message":"moved"}'],
      ['invalid JSON', '[{"id": "x", oops}]'],
      ['an HTML page', '<!doctype html><title>error</title>'],
    ])('reports %s as fetch_error', async (_label, body) => {
      handlers.internships = () => ok(body);
      const res = await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(res.diagnostics?.detail).toContain('simplifyjobs: invalid feed JSON');
    });

    it('serves a cached copy younger than 6 h after an error, flagged partial', async () => {
      const svc = newService();
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 61 * 60_000;
      handlers.internships = () => {
        throw httpError(503);
      };
      const res = await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(res.jobs).toHaveLength(9);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('internships: served cached copy (age 61m) after Request failed with status code 503');
    });

    it('gives up on a cached copy older than 6 h', async () => {
      const svc = newService();
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 6 * 3_600_000 + 1;
      handlers.robots = () => ({ status: 404, headers: {}, data: '' });
      handlers.internships = () => {
        throw httpError(503);
      };
      const res = await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('does not retry a failed list within the error backoff', async () => {
      const svc = newService();
      handlers.internships = () => {
        throw httpError(503);
      };
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      clock += 30_000;
      await svc.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(feedCalls()).toHaveLength(1);
      clock += 31_000;
      handlers.internships = () => ok(INTERNSHIPS);
      expect((await svc.scrape(input({ jobType: JobType.INTERNSHIP }))).jobs).toHaveLength(9);
      expect(feedCalls()).toHaveLength(2);
    });

    it('skips a row whose mapping throws and keeps the rest', async () => {
      const actual = jest.requireActual('../src/simplifyjobs.mapper').mapRowToJobPost;
      (mapper.mapRowToJobPost as jest.Mock).mockImplementation((row, now, site) => {
        if (row.id.endsWith('203')) throw new Error('bad row');
        return actual(row, now, site);
      });
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const res = await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
        expect(ids(res.jobs)).not.toContain('203');
        expect(res.jobs).toHaveLength(8);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping row 00000000-0000-4000-8000-000000000203'));
      } finally {
        warn.mockRestore();
        (mapper.mapRowToJobPost as jest.Mock).mockImplementation(actual);
      }
    });
  });

  describe('robots.txt', () => {
    it('reads the host robots.txt before the first feed request', async () => {
      await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(mockGet.mock.calls.map(([url]) => url)).toEqual([SIMPLIFYJOBS_ROBOTS_URL, INTERNSHIPS_URL]);
    });

    it('does not request a list robots.txt disallows', async () => {
      handlers.robots = () => ({ status: 200, headers: {}, data: 'User-agent: *\nDisallow: /SimplifyJobs/Summer2027-Internships/\n' });
      const res = await newService().scrape(input());
      expect(feedCalls().map(([url]) => url)).toEqual([NEWGRAD_URL]);
      // 14 live new-grad rows, one of them a repeated URL
      expect(res.jobs).toHaveLength(13);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain(
        'internships: blocked: simplifyjobs: robots.txt disallows /SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
      );
    });

    it('requests nothing when robots.txt is unreachable and was never read', async () => {
      handlers.robots = () => {
        throw httpError(503);
      };
      const res = await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(feedCalls()).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(res.diagnostics?.detail).toContain('robots.txt unreachable');
    });

    it('asks robots.txt for text and treats any 4xx as no restrictions', async () => {
      await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      const [, config] = mockGet.mock.calls.find(([url]) => url === SIMPLIFYJOBS_ROBOTS_URL) as [string, Record<string, unknown>];
      const validate = config.validateStatus as (s: number) => boolean;
      expect(config.responseType).toBe('text');
      expect([200, 404, 410, 403].map(validate)).toEqual([true, true, true, true]);
      expect([500, 503].map(validate)).toEqual([false, false]);
    });
  });

  describe('requests', () => {
    it('asks for bytes, bounds the body and accepts 304', async () => {
      await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      const [, config] = feedCalls()[0];
      expect(config.responseType).toBe('arraybuffer');
      expect(config.maxContentLength).toBe(64 * 1024 * 1024);
      expect((config.headers as Record<string, string>).Accept).toBe('application/json, text/plain;q=0.9');
      expect((config.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
      const validate = config.validateStatus as (s: number) => boolean;
      expect([200, 304].map(validate)).toEqual([true, true]);
      expect([301, 404, 500].map(validate)).toEqual([false, false, false]);
    });

    it('parses a Buffer body the same as text', async () => {
      handlers.internships = () => ok(Buffer.from(INTERNSHIPS, 'utf8'));
      expect((await newService().scrape(input({ jobType: JobType.INTERNSHIP }))).jobs).toHaveLength(9);
    });

    it('identifies honestly, pins redirects to the feed host and spaces requests', async () => {
      await newService().scrape(input({ jobType: JobType.INTERNSHIP, proxies: ['http://proxy:1'] }));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: SIMPLIFYJOBS_USER_AGENT,
          proxies: ['http://proxy:1'],
          timeout: 60,
          requestTimeout: 60,
          retries: 2,
          rateDelayMin: 2,
          rateDelayMax: 2,
          allowedRedirectHosts: ['raw.githubusercontent.com'],
        }),
      );
    });

    it('passes a caller User-Agent, timeout and retries through; spacing only grows', async () => {
      await newService().scrape(
        input({ jobType: JobType.INTERNSHIP, userAgent: 'CustomAgent/2.0', requestTimeout: 15, retries: 0, rateDelayMin: 0.5, rateDelayMax: 5 }),
      );
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: 'CustomAgent/2.0', timeout: 15, retries: 0, rateDelayMin: 2, rateDelayMax: 5 }),
      );
    });
  });

  describe('configuration', () => {
    it('takes the internship repository from the environment', async () => {
      process.env.SIMPLIFYJOBS_INTERNSHIPS_REPO = 'SimplifyJobs/Summer2028-Internships';
      await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(feedCalls()[0][0]).toBe(
        'https://raw.githubusercontent.com/SimplifyJobs/Summer2028-Internships/dev/.github/scripts/listings.json',
      );
    });

    it('takes the new-grad repository and branch from the environment', () => {
      process.env.SIMPLIFYJOBS_NEWGRAD_REPO = 'SimplifyJobs/New-Grad-Positions-2027';
      process.env.SIMPLIFYJOBS_BRANCH = 'release/v2';
      expect(newService().resolveFeedUrls().newgrad).toBe(
        'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions-2027/release/v2/.github/scripts/listings.json',
      );
    });

    it.each([
      ['SIMPLIFYJOBS_INTERNSHIPS_REPO', '../x'],
      ['SIMPLIFYJOBS_INTERNSHIPS_REPO', 'SimplifyJobs/../../etc'],
      ['SIMPLIFYJOBS_INTERNSHIPS_REPO', 'evil.example.com/x/y'],
      ['SIMPLIFYJOBS_INTERNSHIPS_REPO', 'https://evil.example/x'],
      ['SIMPLIFYJOBS_BRANCH', '../main'],
      ['SIMPLIFYJOBS_BRANCH', 'dev//x'],
      ['SIMPLIFYJOBS_BRANCH', 'dev?x=1'],
    ])('ignores an invalid %s=%j, warning once', async (key, value) => {
      process.env[key] = value;
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const svc = newService();
        expect(svc.resolveFeedUrls().internships).toBe(INTERNSHIPS_URL);
        svc.resolveFeedUrls();
        expect(warn.mock.calls.filter(([m]) => String(m).includes(`ignoring invalid ${key}`))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('warns when a list has not moved in over 14 days', async () => {
      clock = NOW_MS + 30 * 86_400_000;
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        await newService().scrape(input({ jobType: JobType.INTERNSHIP }));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('check SIMPLIFYJOBS_INTERNSHIPS_REPO'));
      } finally {
        warn.mockRestore();
      }
    });
  });
});
