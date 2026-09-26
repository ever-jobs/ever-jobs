import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  Country,
  DescriptionFormat,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((_options?: unknown) => ({
  get: mockGet,
  setHeaders: mockSetHeaders,
}));
const mockRandomSleep = jest.fn((_min?: number, _max?: number) => Promise.resolve());

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (options?: unknown) => mockCreateHttpClient(options),
    randomSleep: (min: number, max: number) => mockRandomSleep(min, max),
  };
});

import { NaukriModule } from '../src/naukri.module';
import { NaukriService } from '../src/naukri.service';
import {
  NAUKRI_DIAGNOSTICS_ENV,
  NAUKRI_PARSER_ENV,
  NAUKRI_SEARCH_URL,
} from '../src/naukri.constants';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const PAGE_1 = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'naukri-search-page1.json'), 'utf8'),
);
const RECAPTCHA_406 = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'naukri-search-406-recaptcha.json'), 'utf8'),
);

/** Test clock: 2026-09-24T12:00:00Z (17:30 IST). */
const CLOCK = Date.parse('2026-09-24T12:00:00Z');

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function page(overrides: Record<string, unknown> = {}): { data: unknown } {
  return { data: { ...clone(PAGE_1), ...overrides } };
}

function axiosError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

function byId(jobs: JobPostDto[], suffix: string): JobPostDto {
  const job = jobs.find((j) => j.id === `nk-2409260000${suffix}`);
  if (!job) throw new Error(`no job nk-2409260000${suffix}`);
  return job;
}

async function run(input: Partial<ScraperInputDto> = {}): Promise<JobResponseDto> {
  return new NaukriService().scrape({
    siteType: [Site.NAUKRI],
    searchTerm: 'developer',
    ...input,
  } as ScraperInputDto);
}

/**
 * Spec 1712 - `NaukriService` with mocked HTTP. The fixture is synthetic (the
 * live endpoint could not be sampled): 5 valid rows, a duplicate id and a row
 * without an id.
 */
describe('NaukriService (Spec 1712)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockClear();
    mockRandomSleep.mockClear();
    delete process.env[NAUKRI_PARSER_ENV];
    delete process.env[NAUKRI_DIAGNOSTICS_ENV];
    jest.spyOn(Date, 'now').mockReturnValue(CLOCK);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    delete process.env[NAUKRI_PARSER_ENV];
    delete process.env[NAUKRI_DIAGNOSTICS_ENV];
  });

  describe('registration', () => {
    it('resolves through NaukriModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [NaukriModule] }).compile();
      expect(moduleRef.get(NaukriService)).toBeInstanceOf(NaukriService);
      await moduleRef.close();
    });

    it('keeps Site.NAUKRI = "naukri"', () => {
      expect(Site.NAUKRI).toBe('naukri');
    });
  });

  describe('happy path', () => {
    it('maps the fixture to 5 jobs, skipping the duplicate and the id-less row', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs, diagnostics } = await run();

      expect(diagnostics).toBeUndefined();
      expect(jobs.map((j) => j.id)).toEqual([
        'nk-240926000001',
        'nk-240926000002',
        'nk-240926000003',
        'nk-240926000004',
        'nk-240926000005',
      ]);
      for (const j of jobs) expect(j.site).toBe(Site.NAUKRI);
      // noOfJobs = 7 fits in one page of 20: no second request.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).not.toHaveBeenCalled();
    });

    it('builds URLs from relative paths and preserves an absolute jdURL', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      expect(byId(jobs, '01').jobUrl).toBe(
        'https://www.naukri.com/job-listings-senior-node-js-developer-acme-softech-bengaluru-5-to-8-years-240926000001',
      );
      expect(byId(jobs, '01').companyUrl).toBe('https://www.naukri.com/acme-softech-jobs-careers-1001');
      expect(byId(jobs, '04').jobUrl).toBe('https://www.naukri.com/job-listings-qa-engineer-delta-240926000004');
      expect(byId(jobs, '04').companyUrl).toBeNull();
    });

    it('coerces skills, rating, reviews and vacancies', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      const j1 = byId(jobs, '01');
      expect(j1.skills).toEqual(['Node.Js', 'REST', 'Microservices', 'AWS']);
      expect(j1.companyRating).toBe(3.9);
      expect(j1.companyReviewsCount).toBe(1234);
      expect(j1.vacancyCount).toBe(3);
      expect(j1.experienceRange).toBe('5-8 Yrs');
      expect(j1.companyLogo).toBe('https://img.naukimg.com/logo_images/groups/v1/1001.gif');

      const j2 = byId(jobs, '02');
      expect(j2.companyRating).toBeNull();
      expect(j2.companyReviewsCount).toBe(0);
      expect(j2.vacancyCount).toBeNull();
      expect(j2.companyLogo).toBe('https://img.naukimg.com/logo_images/groups/v1/1002.gif');

      expect(byId(jobs, '03').skills).toBeNull();
    });

    it('parses salary chips into INR with an interval', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      expect(byId(jobs, '01').compensation).toMatchObject({
        minAmount: 1_200_000,
        maxAmount: 1_600_000,
        interval: CompensationInterval.YEARLY,
        currency: 'INR',
      });
      expect(byId(jobs, '02').compensation).toBeNull();
      expect(byId(jobs, '03').compensation).toMatchObject({ minAmount: 8_000_000, maxAmount: 12_000_000 });
      expect(byId(jobs, '04').compensation).toMatchObject({ minAmount: null, maxAmount: 1_000_000 });
      expect(byId(jobs, '05').compensation).toMatchObject({ minAmount: 250_000, maxAmount: 350_000 });
    });

    it('dates rows by IST day; an open-ended label defers to createdDate', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      expect(byId(jobs, '01').datePosted).toBe('2026-09-24');
      expect(byId(jobs, '02').datePosted).toBe('2026-09-21');
      expect(byId(jobs, '03').datePosted).toBe('2026-08-07');
      expect(byId(jobs, '04').datePosted).toBe('2026-09-24');
      expect(byId(jobs, '05').datePosted).toBe('2026-09-24');
    });
  });

  describe('remote and location regressions', () => {
    it('does not read "This is not a remote role" in the description as remote', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      const j4 = byId(jobs, '04');
      expect(j4.isRemote).toBe(false);
      expect(j4.workFromHomeType).toBeNull();
      expect(j4.locations?.map((l) => l.city)).toEqual(['Pune']);
    });

    it('splits a multi-city label into one location per city', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      const j1 = byId(jobs, '01');
      expect(j1.locations).toHaveLength(3);
      expect(j1.locations?.map((l) => l.city)).toEqual(['Bengaluru', 'Hyderabad', 'Pune']);
      expect(j1.location?.country).toBe(Country.INDIA);
      expect(j1.isRemote).toBe(false);
    });

    it('takes hybrid from the label, not from "Remote-friendly" in the description', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      const j2 = byId(jobs, '02');
      expect(j2.workFromHomeType).toBe('Hybrid');
      expect(j2.isRemote).toBe(false);
      expect(j2.locations?.map((l) => l.city)).toEqual(['Bengaluru', 'Chennai']);
    });

    it('flags Remote and temporary WFH labels as remote', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run();
      expect(byId(jobs, '03').isRemote).toBe(true);
      expect(byId(jobs, '03').locations).toEqual([]);
      expect(byId(jobs, '05').isRemote).toBe(true);
      expect(byId(jobs, '05').locations?.map((l) => l.city)).toEqual(['Mumbai']);
    });
  });

  describe('description formats', () => {
    it('HTML passes the snippet through', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run({ descriptionFormat: DescriptionFormat.HTML });
      expect(byId(jobs, '01').description).toBe('Build <b>REST APIs</b> in Node.js.<br>Own services end to end.');
    });

    it('MARKDOWN converts the snippet', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run({ descriptionFormat: DescriptionFormat.MARKDOWN });
      expect(byId(jobs, '01').description).toContain('**REST APIs**');
    });

    it('PLAIN strips the markup', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run({ descriptionFormat: DescriptionFormat.PLAIN });
      expect(byId(jobs, '01').description).toBe('Build REST APIs in Node.js.\nOwn services end to end.');
    });
  });

  describe('request shape', () => {
    it('sends the search parameters and the board headers', async () => {
      mockGet.mockResolvedValueOnce(page());
      await run({ searchTerm: 'Node JS', location: 'Pune', isRemote: true });

      const [url, config] = mockGet.mock.calls[0];
      expect(url).toBe(NAUKRI_SEARCH_URL);
      expect(config.params).toMatchObject({
        pageNo: 1,
        noOfResults: 20,
        keyword: 'Node JS',
        k: 'Node JS',
        seoKey: 'node-js-jobs',
        src: 'jobsearchDesk',
        urlType: 'search_by_keyword',
        searchType: 'adv',
        latLong: '',
        location: 'Pune',
        remote: 'true',
      });
      expect(config.params.days).toBeUndefined();
      expect(mockSetHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ appid: '109', systemid: 'Naukri' }),
      );
    });

    it('defaults requestTimeout to 20 s', async () => {
      mockGet.mockResolvedValueOnce(page());
      await run();
      expect(mockCreateHttpClient).toHaveBeenCalledWith(expect.objectContaining({ requestTimeout: 20 }));
    });

    it('keeps the caller timeout when proxies are set', async () => {
      mockGet.mockResolvedValueOnce(page());
      await run({ proxies: ['http://p'], requestTimeout: 7 });
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ proxies: ['http://p'], requestTimeout: 7 }),
      );
    });

    it("lets the caller's user agent win over the constant", async () => {
      mockGet.mockResolvedValueOnce(page());
      await run({ userAgent: 'EverJobsTest/1.0' });
      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: 'EverJobsTest/1.0' }),
      );
      expect(mockSetHeaders).toHaveBeenLastCalledWith({ 'user-agent': 'EverJobsTest/1.0' });
    });
  });

  describe('offset, paging and hoursOld', () => {
    it('offset 22 requests page 2 and skips its first 2 rows', async () => {
      mockGet.mockResolvedValueOnce(page());
      const { jobs } = await run({ offset: 22 });
      expect(mockGet.mock.calls[0][1].params.pageNo).toBe(2);
      expect(jobs.map((j) => j.id)).toEqual(['nk-240926000003', 'nk-240926000004', 'nk-240926000005']);
    });

    it('hoursOld 25 asks for 2 days', async () => {
      mockGet.mockResolvedValueOnce(page());
      await run({ hoursOld: 25 });
      expect(mockGet.mock.calls[0][1].params.days).toBe(2);
    });

    it('hoursOld 72 drops the 48-day-old row client-side and keeps undated rows', async () => {
      const data = page().data as { jobDetails: Array<Record<string, unknown>> };
      delete data.jobDetails[4].footerPlaceholderLabel; // row 5: no label, no createdDate
      mockGet.mockResolvedValueOnce({ data });
      const { jobs } = await run({ hoursOld: 72 });
      expect(mockGet.mock.calls[0][1].params.days).toBe(3);
      expect(jobs.map((j) => j.id)).toEqual([
        'nk-240926000001',
        'nk-240926000002',
        'nk-240926000004',
        'nk-240926000005',
      ]);
      expect(byId(jobs, '05').datePosted).toBeNull();
    });

    it('pages on with a polite delay until resultsWanted, then stops', async () => {
      mockGet
        .mockResolvedValueOnce(page({ noOfJobs: 1000 }))
        .mockResolvedValueOnce({ data: { jobDetails: [] } });
      const { jobs, diagnostics } = await run({ resultsWanted: 50 });
      expect(jobs).toHaveLength(5);
      expect(diagnostics).toBeUndefined();
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet.mock.calls[1][1].params.pageNo).toBe(2);
      expect(mockRandomSleep).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).toHaveBeenCalledWith(3000, 7000);
    });

    it('stops at resultsWanted without another request or delay', async () => {
      mockGet.mockResolvedValueOnce(page({ noOfJobs: 1000 }));
      const { jobs } = await run({ resultsWanted: 2 });
      expect(jobs).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).not.toHaveBeenCalled();
    });
  });

  describe('diagnostics', () => {
    it('(a) a 406 recaptcha refusal on page 1 is blocked, not bad_input', async () => {
      mockGet.mockRejectedValueOnce(axiosError(406, clone(RECAPTCHA_406)));
      const { jobs, diagnostics } = await run();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
      expect(diagnostics?.detail).toMatch(/recaptcha/);
      expect(diagnostics?.detail).toBe('HTTP 406: recaptcha required');
    });

    it('(b) a refusal on page 2 keeps page 1 jobs', async () => {
      mockGet
        .mockResolvedValueOnce(page({ noOfJobs: 1000 }))
        .mockRejectedValueOnce(axiosError(406, clone(RECAPTCHA_406)));
      const { jobs, diagnostics } = await run();
      expect(jobs).toHaveLength(5);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('(c) a 200 carrying the captcha message is blocked', async () => {
      mockGet.mockResolvedValueOnce({ data: { message: 'recaptcha required' } });
      const { jobs, diagnostics } = await run();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('(d) a 200 challenge page is blocked', async () => {
      mockGet.mockResolvedValueOnce({ data: '<html><title>Just a moment...</title></html>' });
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('blocked');
    });

    it('(e) a timeout stays timeout', async () => {
      mockGet.mockRejectedValueOnce(
        Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true }),
      );
      const { jobs, diagnostics } = await run();
      expect(jobs).toEqual([]);
      expect(diagnostics?.reason).toBe('timeout');
    });

    it('(f) a 404 keeps the shared classifier (bad_input)', async () => {
      mockGet.mockRejectedValueOnce(axiosError(404, { message: 'Not Found' }));
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('bad_input');
    });

    it('(g) an empty page is empty, with no diagnostic', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobDetails: [] } });
      const { jobs, diagnostics } = await run();
      expect(jobs).toEqual([]);
      expect(diagnostics).toBeUndefined();
    });

    it('(h) a non-JSON 200 without a challenge is fetch_error', async () => {
      mockGet.mockResolvedValueOnce({ data: '<html><body>search page</body></html>' });
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('fetch_error');
      expect(diagnostics?.detail).toBe('naukri: non-JSON search response');
    });

    it('(i) a 5xx after retries is fetch_error', async () => {
      mockGet.mockRejectedValueOnce(axiosError(503, 'Service Unavailable'));
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('fetch_error');
    });

    it('(j) one malformed row is skipped and the page continues', async () => {
      const data = page().data as { jobDetails: unknown[] };
      data.jobDetails.splice(1, 0, null, 'not-an-object');
      mockGet.mockResolvedValueOnce({ data });
      const { jobs, diagnostics } = await run();
      expect(jobs).toHaveLength(5);
      expect(diagnostics).toBeUndefined();
    });
  });

  describe(`${NAUKRI_DIAGNOSTICS_ENV}=legacy (pre-1712 failure reporting)`, () => {
    beforeEach(() => {
      process.env[NAUKRI_DIAGNOSTICS_ENV] = 'legacy';
    });

    it('reports the 406 through the shared classifier (bad_input)', async () => {
      mockGet.mockRejectedValueOnce(axiosError(406, clone(RECAPTCHA_406)));
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('bad_input');
    });

    it('reads a 200 captcha body as an empty board', async () => {
      mockGet.mockResolvedValueOnce({ data: { message: 'recaptcha required' } });
      const { jobs, diagnostics } = await run();
      expect(jobs).toEqual([]);
      expect(diagnostics).toBeUndefined();
    });
  });

  describe(`${NAUKRI_PARSER_ENV}=legacy (pre-1712 row mapping)`, () => {
    beforeEach(() => {
      process.env[NAUKRI_PARSER_ENV] = 'legacy';
    });

    it('restores the description scan, single location and range-only salary', async () => {
      mockGet.mockResolvedValueOnce(page()).mockResolvedValueOnce({ data: { jobDetails: [] } });
      const { jobs } = await run();
      expect(jobs).toHaveLength(5);

      const j4 = byId(jobs, '04');
      expect(j4.isRemote).toBe(true);
      expect(j4.workFromHomeType).toBe('Remote');
      expect(j4.compensation).toBeNull();
      expect(j4.jobUrl).toBe('https://www.naukri.comhttps://www.naukri.com/job-listings-qa-engineer-delta-240926000004');

      const j1 = byId(jobs, '01');
      expect(j1.locations).toHaveLength(1);
      expect(j1.location?.city).toBe('Bengaluru, Hyderabad, Pune');
      expect(j1.compensation?.minAmount).toBe(1_200_000);
      expect(j1.compensation?.interval).toBeUndefined();
      expect(j1.skills).toEqual(['Node.Js', 'REST', 'Microservices', 'AWS']);
      expect(byId(jobs, '02').vacancyCount).toBe(0);
    });

    it('ignores noOfJobs and keeps page-granular offset', async () => {
      mockGet.mockResolvedValueOnce(page()).mockResolvedValueOnce({ data: { jobDetails: [] } });
      const { jobs } = await run({ offset: 22 });
      expect(mockGet.mock.calls[0][1].params.pageNo).toBe(2);
      expect(jobs[0].id).toBe('nk-240926000001');
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('does not filter by hoursOld client-side', async () => {
      mockGet.mockResolvedValueOnce(page()).mockResolvedValueOnce({ data: { jobDetails: [] } });
      const { jobs } = await run({ hoursOld: 72 });
      expect(jobs.map((j) => j.id)).toContain('nk-240926000003');
    });

    it('still reports the captcha gate as blocked (diagnostics are separate)', async () => {
      mockGet.mockRejectedValueOnce(axiosError(406, clone(RECAPTCHA_406)));
      const { diagnostics } = await run();
      expect(diagnostics?.reason).toBe('blocked');
    });
  });

  it('warns on an unrecognised mode and uses the default', async () => {
    process.env[NAUKRI_PARSER_ENV] = 'old';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockGet.mockResolvedValueOnce(page());
    const { jobs } = await run();
    expect(byId(jobs, '04').isRemote).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${NAUKRI_PARSER_ENV}="old"`));
  });
});
