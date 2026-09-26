import 'reflect-metadata';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((_options?: unknown) => ({
  get: mockGet,
  post: mockPost,
  setHeaders: mockSetHeaders,
}));
const mockRandomSleep = jest.fn().mockResolvedValue(undefined);

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: (options?: unknown) => mockCreateHttpClient(options),
  randomSleep: (...args: unknown[]) => mockRandomSleep(...args),
}));

import { readFileSync } from 'fs';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import {
  CompensationInterval,
  Country,
  DescriptionFormat,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { ZipRecruiterService } from '../src/ziprecruiter.service';
import {
  GEO_BLOCK_MEMO_MAX_ENTRIES,
  GEO_BLOCK_TTL_MS,
  MAX_PAGES,
  SESSION_EVENT_DATA,
  ZIPRECRUITER_EVENT_URL,
  ZIPRECRUITER_GEO_BLOCK_TTL_ENV,
  ZIPRECRUITER_HOURS_FILTER_ENV,
  ZIPRECRUITER_LEGACY_PARAMS_ENV,
  ZIPRECRUITER_SESSION_EVENT_ENV,
  ZIPRECRUITER_MAX_PAGES_ENV,
  ZIPRECRUITER_REGION_GUARD_ENV,
  ZIPRECRUITER_SEARCH_URL,
  buildSessionEventBody,
  isGeoBlockError,
  isSupportedCountry,
  resolveZipRecruiterOptions,
  zipRecruiterJobUrl,
} from '../src/ziprecruiter.constants';

/**
 * Spec 1713: ZipRecruiter region guard, geo-block diagnostics and the jobs-app
 * response contract. Fixtures are synthetic (no live 200 sample could be
 * captured from our egress); see fixtures/jobs-page1.json.
 */

const FIXTURES = join(__dirname, 'fixtures');
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const page1 = () => fixture('jobs-page1.json');
const page2 = () => fixture('jobs-page2.json');
const cfWafBody = () => fixture('forbidden-cf-waf.json');

const ok = (data: unknown) => ({ status: 200, data });
const httpError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
const cfWaf = () => httpError(403, cfWafBody());

const OWN_ENV = [
  ZIPRECRUITER_REGION_GUARD_ENV,
  ZIPRECRUITER_GEO_BLOCK_TTL_ENV,
  ZIPRECRUITER_MAX_PAGES_ENV,
  ZIPRECRUITER_LEGACY_PARAMS_ENV,
  ZIPRECRUITER_HOURS_FILTER_ENV,
  ZIPRECRUITER_SESSION_EVENT_ENV,
  'EVER_JOBS_POSTED_TIME_DETAIL',
];

const T0 = Date.parse('2026-09-24T12:00:00Z');

function newService(nowMs: number = T0): { service: ZipRecruiterService; setNow: (ms: number) => void } {
  const service = new ZipRecruiterService();
  let clock = nowMs;
  (service as unknown as { now: () => number }).now = () => clock;
  return { service, setNow: (ms: number) => (clock = ms) };
}

function input(partial: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.ZIP_RECRUITER],
    searchTerm: 'engineer',
    location: 'Austin, TX',
    ...partial,
  });
}

const getParams = (call: number): Record<string, unknown> => mockGet.mock.calls[call][1].params;

describe('ZipRecruiterService (Spec 1713)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  const logSpies: jest.SpyInstance[] = [];

  beforeAll(() => {
    for (const name of OWN_ENV) savedEnv[name] = process.env[name];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      logSpies.push(jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReset();
    mockPost.mockReset();
    mockPost.mockResolvedValue(ok({}));
    for (const name of OWN_ENV) delete process.env[name];
  });

  afterAll(() => {
    for (const spy of logSpies) spy.mockRestore();
    for (const name of OWN_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('region guard', () => {
    it.each([Country.GERMANY, Country.UK])('%s: no request, bad_input naming US/Canada', async (country) => {
      const { service } = newService();

      const result = await service.scrape(input({ country }));

      expect(mockCreateHttpClient).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
      expect(result.diagnostics?.detail).toMatch(/US\/Canada/);
      expect(result.diagnostics?.detail).toContain(country);
    });

    it.each([Country.USA, Country.CANADA, Country.US_CANADA, Country.WORLDWIDE, undefined])(
      '%s: searches',
      async (country) => {
        mockGet.mockResolvedValueOnce(ok(page1()));
        const { service } = newService();

        const result = await service.scrape(input({ country, resultsWanted: 2 }));

        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(mockGet.mock.calls[0][0]).toBe(ZIPRECRUITER_SEARCH_URL);
        expect(result.jobs).toHaveLength(2);
        expect(result.diagnostics).toBeUndefined();
      },
    );

    it(`${ZIPRECRUITER_REGION_GUARD_ENV}=false restores searching every country`, async () => {
      process.env[ZIPRECRUITER_REGION_GUARD_ENV] = 'false';
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      const result = await service.scrape(input({ country: Country.GERMANY, resultsWanted: 2 }));

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toHaveLength(2);
    });

    it('isSupportedCountry accepts the North-American set only', () => {
      expect(isSupportedCountry(undefined)).toBe(true);
      expect(isSupportedCountry(null)).toBe(true);
      expect(isSupportedCountry('usa')).toBe(true);
      expect(isSupportedCountry(Country.CANADA)).toBe(true);
      expect(isSupportedCountry(Country.MEXICO)).toBe(false);
      expect(isSupportedCountry(Country.UK)).toBe(false);
    });
  });

  describe('pagination', () => {
    it('reads `continue` and sends it back as `continue_from` (never `continue_token`)', async () => {
      mockGet.mockResolvedValueOnce(ok({ ...page1(), continue: 'tok1' })).mockResolvedValueOnce(ok(page2()));
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 10 }));

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(getParams(0).continue_from).toBeUndefined();
      expect(getParams(1).continue_from).toBe('tok1');
      for (const call of [0, 1]) expect(getParams(call)).not.toHaveProperty('continue_token');
      expect(result.jobs.map((j) => j.id)).toEqual([
        'zr-AbCdEf0123456789xyz',
        'zr-ZyXw9876543210abc',
        'zr-Qwerty5555555555aaa',
      ]);
    });

    it('sleeps 5-10 s between pages, never before the first', async () => {
      mockGet.mockResolvedValueOnce(ok(page1())).mockResolvedValueOnce(ok(page2()));
      const { service } = newService();

      await service.scrape(input({ resultsWanted: 10 }));

      expect(mockRandomSleep).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).toHaveBeenCalledWith(5000, 10000);
    });

    it('stops when a page adds no new ids even though a token is returned', async () => {
      mockGet
        .mockResolvedValueOnce(ok({ ...page1(), continue: 'tok1' }))
        .mockResolvedValueOnce(ok({ ...page1(), continue: 'tok2' }))
        .mockResolvedValue(ok({ ...page1(), continue: 'tok3' }));
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 30 }));

      expect(mockGet.mock.calls.length).toBeLessThanOrEqual(2);
      expect(result.jobs).toHaveLength(2);
    });

    it('stops on an empty page', async () => {
      mockGet.mockResolvedValueOnce(ok({ jobs: [], continue: 'tok' }));
      const { service } = newService();

      const result = await service.scrape(input());

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeUndefined();
    });

    it(`caps pages at ${MAX_PAGES} however many results are wanted`, async () => {
      let n = 0;
      mockGet.mockImplementation(async () => {
        n++;
        return ok({ jobs: [{ listing_key: `k${n}`, name: `Job ${n}` }], continue: `tok${n}` });
      });
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 1000 }));

      expect(mockGet).toHaveBeenCalledTimes(MAX_PAGES);
      expect(result.jobs).toHaveLength(MAX_PAGES);
    });

    it('sizes the page budget from resultsWanted + offset', async () => {
      let n = 0;
      mockGet.mockImplementation(async () => {
        n++;
        return ok({ jobs: [{ listing_key: `k${n}`, name: `Job ${n}` }], continue: `tok${n}` });
      });
      const { service } = newService();

      // ceil(15 / 20) + 1 = 2 pages
      await service.scrape(input({ resultsWanted: 15 }));

      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it(`${ZIPRECRUITER_MAX_PAGES_ENV} sets an absolute page cap`, async () => {
      process.env[ZIPRECRUITER_MAX_PAGES_ENV] = '3';
      let n = 0;
      mockGet.mockImplementation(async () => {
        n++;
        return ok({ jobs: [{ listing_key: `k${n}`, name: `Job ${n}` }], continue: `tok${n}` });
      });
      const { service } = newService();

      await service.scrape(input({ resultsWanted: 15 }));

      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('offset skips the first unique jobs', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      const result = await service.scrape(input({ offset: 1, resultsWanted: 1 }));

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs.map((j) => j.title)).toEqual(['Warehouse Associate']);
    });

    it('resultsWanted 0 makes no request', async () => {
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 0 }));

      expect(mockPost).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
      expect(result.jobs).toEqual([]);
    });
  });

  describe('field mapping', () => {
    async function scrapeBoth(partial: Partial<ScraperInputDto> = {}) {
      mockGet.mockResolvedValueOnce(ok(page1())).mockResolvedValueOnce(ok(page2()));
      const { service } = newService();
      return service.scrape(input({ resultsWanted: 10, ...partial }));
    }

    it('maps the annual USD job', async () => {
      const [job] = (await scrapeBoth()).jobs;

      expect(job.id).toBe('zr-AbCdEf0123456789xyz');
      expect(job.title).toBe('Senior Frontend Engineer');
      expect(job.jobUrl).toBe('https://www.ziprecruiter.com/jobs//j?lvk=AbCdEf0123456789xyz');
      expect(job.companyName).toBe('Acme Example Inc');
      expect(job.compensation).toEqual(
        expect.objectContaining({
          minAmount: 120000,
          maxAmount: 150000,
          interval: CompensationInterval.YEARLY,
          currency: 'USD',
        }),
      );
      expect(job.datePosted).toBe('2026-09-20');
      expect(job.datePostedAt).toBe('2026-09-20T23:10:00.000Z');
      expect(job.listingType).toBe('organic');
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.countryCode).toBe('US');
      expect(job.location).toEqual(
        expect.objectContaining({ city: 'Austin', state: 'TX', country: 'United States' }),
      );
      expect(job.isRemote).toBe(false);
      expect(job.emails).toEqual(['jobs@acme-example.com']);
      expect(job.description).toContain('**React**');
      expect(job.jobUrlDirect).toBeNull();
      expect(job.site).toBe(Site.ZIP_RECRUITER);
    });

    it('maps the hourly CAD job', async () => {
      const job = (await scrapeBoth()).jobs[1];

      expect(job.compensation).toEqual(
        expect.objectContaining({
          minAmount: 18.5,
          maxAmount: 21,
          interval: CompensationInterval.HOURLY,
          currency: 'CAD',
        }),
      );
      expect(job.jobType).toEqual([JobType.PART_TIME]);
      expect(job.listingType).toBe('sponsored');
    });

    it('maps `contractor` to CONTRACT and a Remote city to isRemote', async () => {
      const job = (await scrapeBoth()).jobs[2];

      expect(job.jobType).toEqual([JobType.CONTRACT]);
      expect(job.isRemote).toBe(true);
      expect(job.compensation).toBeNull();
      expect(job.countryCode).toBe('US');
    });

    it('reads CA as Canada, never California', async () => {
      const job = (await scrapeBoth()).jobs[1];

      expect(job.countryCode).toBe('CA');
      expect(job.location).toEqual(
        expect.objectContaining({ city: 'Toronto', state: 'ON', country: 'Canada' }),
      );
      expect(JSON.stringify(job.location)).not.toMatch(/California/);
    });

    it('drops a record without an id and keeps the rest of the page', async () => {
      const result = await scrapeBoth();

      expect(result.jobs).toHaveLength(3);
      expect(result.jobs.map((j) => j.title)).not.toContain(
        'Record without listing_key (must be dropped, not crash the page)',
      );
      expect(result.diagnostics).toBeUndefined();
    });

    it('keeps a job whose `remote` is a boolean (it used to throw and drop it)', async () => {
      mockGet.mockResolvedValueOnce(
        ok({
          jobs: [
            { listing_key: 'r1', name: 'Remote boolean', remote: true, job_city: 'Austin', job_state: 'TX', job_country: 'US' },
            { listing_key: 'r2', name: 'Remote string', remote: 'TRUE', job_country: 'US' },
            { listing_key: 'r3', name: 'Onsite', remote: false, job_city: 'Austin', job_state: 'TX', job_country: 'US' },
          ],
        }),
      );
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.jobs.map((j) => [j.title, j.isRemote])).toEqual([
        ['Remote boolean', true],
        ['Remote string', true],
        ['Onsite', false],
      ]);
    });

    it('marks every job remote when the search asked for remote=1', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      const result = await service.scrape(input({ isRemote: true, resultsWanted: 2 }));

      expect(result.jobs.every((j) => j.isRemote === true)).toBe(true);
    });

    it('description formats: markdown, plain, html', async () => {
      const md = (await scrapeBoth({ descriptionFormat: DescriptionFormat.MARKDOWN })).jobs[0];
      const plain = (await scrapeBoth({ descriptionFormat: DescriptionFormat.PLAIN })).jobs[0];
      const html = (await scrapeBoth({ descriptionFormat: DescriptionFormat.HTML })).jobs[0];

      expect(md.description).toContain('**React**');
      expect(plain.description).toContain('Build React apps');
      expect(plain.description).not.toContain('<');
      expect(html.description).toBe(
        '<p>Build <strong>React</strong> apps. Contact jobs@acme-example.com.</p>',
      );
    });

    it('takes jobUrlDirect from apply_url, unwrapping a job_url parameter', async () => {
      const target = 'https://careers.example.com/apply?id=7&src=zr';
      mockGet.mockResolvedValueOnce(
        ok({
          jobs: [
            { listing_key: 'a1', name: 'Plain apply', apply_url: 'https://careers.example.com/a1' },
            {
              listing_key: 'a2',
              name: 'Wrapped apply',
              apply_url: `https://www.ziprecruiter.com/save?job_url=${encodeURIComponent(target)}`,
            },
            {
              listing_key: 'a3',
              name: 'Save link only',
              save_job_url: `https://www.ziprecruiter.com/save?job_url=${encodeURIComponent(target)}`,
            },
            { listing_key: 'a4', name: 'Save link without target', save_job_url: 'https://www.ziprecruiter.com/save' },
          ],
        }),
      );
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.jobs.map((j) => j.jobUrlDirect)).toEqual([
        'https://careers.example.com/a1',
        target,
        target,
        null,
      ]);
    });

    it('falls back to the retired id, link and salary fields', async () => {
      mockGet.mockResolvedValueOnce(
        ok({
          jobs: [
            {
              job_id: 12345,
              name: 'Legacy shape',
              job_url: 'https://www.ziprecruiter.com/c/Example/Job/Legacy',
              salary_min_annual: 90000,
              salary_max_annual: 110000,
              employment_type: 'full_time',
            },
            { id: 'legacy-2', title: 'Title field', url: 'https://example.com/legacy-2' },
            { id: 'no-url', name: 'No link anywhere' },
          ],
        }),
      );
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.jobs.map((j) => [j.id, j.title, j.jobUrl])).toEqual([
        ['zr-12345', 'Legacy shape', 'https://www.ziprecruiter.com/c/Example/Job/Legacy'],
        ['zr-legacy-2', 'Title field', 'https://example.com/legacy-2'],
      ]);
      expect(result.jobs[0].compensation).toEqual(
        expect.objectContaining({
          minAmount: 90000,
          maxAmount: 110000,
          interval: CompensationInterval.YEARLY,
          currency: 'USD',
        }),
      );
      expect(result.jobs.every((j) => j.jobUrl !== '')).toBe(true);
    });

    it('defaults the currency by country and reads unusual period labels', async () => {
      mockGet.mockResolvedValueOnce(
        ok({
          jobs: [
            { listing_key: 'c1', name: 'CA no currency', job_country: 'CA', compensation_min: 60000 },
            { listing_key: 'c2', name: 'US per hour', job_country: 'US', compensation_max: '30', compensation_interval: 'per hour' },
            { listing_key: 'c3', name: 'Zero pay', job_country: 'US', compensation_min: 0, compensation_max: 0 },
          ],
        }),
      );
      const { service } = newService();

      const [ca, hourly, zero] = (await service.scrape(input())).jobs;

      expect(ca.compensation).toEqual(
        expect.objectContaining({ minAmount: 60000, maxAmount: null, interval: CompensationInterval.YEARLY, currency: 'CAD' }),
      );
      expect(hourly.compensation).toEqual(
        expect.objectContaining({ minAmount: null, maxAmount: 30, interval: CompensationInterval.HOURLY, currency: 'USD' }),
      );
      expect(zero.compensation).toBeNull();
    });

    it('builds the public link with the double slash and an encoded key', () => {
      expect(zipRecruiterJobUrl('a b/c')).toBe('https://www.ziprecruiter.com/jobs//j?lvk=a%20b%2Fc');
    });
  });

  describe('query parameters', () => {
    it('uses the jobs-app names', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      await service.scrape(
        input({
          hoursOld: 36,
          isRemote: true,
          easyApply: true,
          distance: 25,
          jobType: JobType.FULL_TIME,
          resultsWanted: 2,
        }),
      );

      const params = getParams(0);
      expect(params).toEqual(
        expect.objectContaining({
          search: 'engineer',
          location: 'Austin, TX',
          radius: 25,
          days: 2,
          remote: 1,
          zipapply: 1,
          employment_type: 'full_time',
        }),
      );
      for (const retired of ['radius_miles', 'days_ago', 'form', 'continue_token']) {
        expect(params).not.toHaveProperty(retired);
      }
    });

    it('sends no remote, zipapply or days when not asked', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      await service.scrape(input({ resultsWanted: 2 }));

      const params = getParams(0);
      expect(params.radius).toBe(50);
      for (const absent of ['remote', 'zipapply', 'days', 'employment_type']) {
        expect(params).not.toHaveProperty(absent);
      }
    });

    it('rounds a short hoursOld up to one day', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      await service.scrape(input({ hoursOld: 3, resultsWanted: 2 }));

      expect(getParams(0).days).toBe(1);
    });

    it('omits employment_type for a job type with no known filter value', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      await service.scrape(input({ jobType: JobType.PER_DIEM, resultsWanted: 2 }));

      expect(getParams(0)).not.toHaveProperty('employment_type');
    });

    it(`${ZIPRECRUITER_LEGACY_PARAMS_ENV}=true restores the pre-1713 request contract`, async () => {
      process.env[ZIPRECRUITER_LEGACY_PARAMS_ENV] = 'true';
      mockGet
        .mockResolvedValueOnce(ok({ ...page1(), continue: undefined, continue_token: 'legacy-tok' }))
        .mockResolvedValueOnce(ok(page2()));
      const { service } = newService();

      await service.scrape(
        input({ hoursOld: 36, isRemote: true, easyApply: true, jobType: JobType.PER_DIEM, resultsWanted: 10 }),
      );

      expect(mockPost).toHaveBeenCalledWith(ZIPRECRUITER_EVENT_URL, SESSION_EVENT_DATA);
      expect(getParams(0)).toEqual({
        search: 'engineer',
        location: 'Austin, TX',
        radius_miles: 50,
        form: 'jobs-landing',
        days_ago: 2,
        employment_type: '',
      });
      expect(getParams(1).continue_token).toBe('legacy-tok');
    });
  });

  describe('hoursOld', () => {
    it('drops jobs older than hoursOld and keeps jobs without a posted_time', async () => {
      const data = page1();
      data.jobs.push({ listing_key: 'undated', name: 'Undated job', job_country: 'US' });
      mockGet.mockResolvedValueOnce(ok({ ...data, continue: null }));
      const { service } = newService(T0);

      // T0 - 36 h = 2026-09-23T00:00Z: the 09-20 job is out, the 09-23T08:00 job is in.
      const result = await service.scrape(input({ hoursOld: 36 }));

      expect(result.jobs.map((j) => j.title)).toEqual(['Warehouse Associate', 'Undated job']);
    });

    it(`${ZIPRECRUITER_HOURS_FILTER_ENV}=false keeps the server's whole-day superset`, async () => {
      process.env[ZIPRECRUITER_HOURS_FILTER_ENV] = 'false';
      mockGet.mockResolvedValueOnce(ok({ ...page1(), continue: null }));
      const { service } = newService(T0);

      const result = await service.scrape(input({ hoursOld: 36 }));

      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('session event', () => {
    it('defaults to the pre-1713 JSON event on a client without a cookie jar', async () => {
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService(T0);

      await service.scrape(input({ resultsWanted: 2, proxies: ['http://p:1'] }));

      const options = mockCreateHttpClient.mock.calls[0][0] as Record<string, unknown>;
      expect(options.cookies).toBeUndefined();
      expect(options.proxies).toEqual(['http://p:1']);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(ZIPRECRUITER_EVENT_URL, SESSION_EVENT_DATA);
    });

    it(`${ZIPRECRUITER_SESSION_EVENT_ENV}=off sends no session event`, async () => {
      process.env[ZIPRECRUITER_SESSION_EVENT_ENV] = 'off';
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService(T0);

      const result = await service.scrape(input({ resultsWanted: 2 }));

      expect(mockPost).not.toHaveBeenCalled();
      expect(result.jobs.length).toBeGreaterThan(0);
    });

    it(`${ZIPRECRUITER_SESSION_EVENT_ENV}=form: form-encoded with repeated property entries, on a cookie-enabled client`, async () => {
      process.env[ZIPRECRUITER_SESSION_EVENT_ENV] = 'form';
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService(T0);

      await service.scrape(input({ resultsWanted: 2, proxies: ['http://p:1'] }));

      expect(mockCreateHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ cookies: true, proxies: ['http://p:1'], requestTimeout: 60 }),
      );
      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockPost.mock.calls[0];
      expect(url).toBe(ZIPRECRUITER_EVENT_URL);
      expect(typeof body).toBe('string');
      const form = new URLSearchParams(body as string);
      expect(form.get('event_type')).toBe('session');
      expect(form.get('logged_in')).toBe('false');
      expect(form.getAll('property').length).toBeGreaterThanOrEqual(2);
      expect(form.getAll('property')).toContain(`timestamp:${new Date(T0).toISOString()}`);
      expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('adds no device or app identity beyond the pre-1713 properties', () => {
      const keys = buildSessionEventBody(T0)
        .getAll('property')
        .map((p) => p.slice(0, p.indexOf(':')));

      expect(keys).toEqual([
        'device_make',
        'device_model',
        'device_os',
        'device_form_factor',
        'platform',
        'locale',
        'timestamp',
      ]);
    });

    it('a non-geo session failure is logged and the search still runs', async () => {
      mockPost.mockRejectedValueOnce(httpError(500, 'oops'));
      mockGet.mockResolvedValueOnce(ok(page1()));
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 2 }));

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toHaveLength(2);
      expect(result.diagnostics).toBeUndefined();
    });
  });

  describe('errors and diagnostics', () => {
    it('a cf-waf 403 on the search is reported as a geo restriction', async () => {
      mockGet.mockRejectedValueOnce(cfWaf());
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toMatch(/cf-waf/);
      expect(result.diagnostics?.detail).toMatch(/outside North America/);
      // States the fact; never advises how to get around the restriction.
      expect(result.diagnostics?.detail).not.toMatch(/proxy|route via/i);
    });

    it('a cf-waf 403 on the session skips the search', async () => {
      mockPost.mockRejectedValueOnce(cfWaf());
      const { service } = newService();

      const result = await service.scrape(input());

      expect(mockGet).not.toHaveBeenCalled();
      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toMatch(/cf-waf/);
    });

    it('remembers a geo-block per egress for the TTL', async () => {
      const { service, setNow } = newService(T0);
      mockGet.mockRejectedValueOnce(cfWaf());
      await service.scrape(input());
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Same egress, inside the TTL: no request at all.
      setNow(T0 + GEO_BLOCK_TTL_MS - 1);
      const suppressed = await service.scrape(input());
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(suppressed.diagnostics?.reason).toBe('blocked');
      expect(suppressed.diagnostics?.detail).toMatch(/cf-waf/);
      expect(suppressed.diagnostics?.detail).toMatch(/not retried until/);

      // A proxied request leaves from another egress.
      mockGet.mockResolvedValueOnce(ok(page1()));
      const proxied = await service.scrape(input({ proxies: ['http://p:1'], resultsWanted: 2 }));
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(proxied.jobs).toHaveLength(2);

      // After the TTL the direct egress is tried again.
      setNow(T0 + GEO_BLOCK_TTL_MS + 1);
      mockGet.mockResolvedValueOnce(ok(page1()));
      const retried = await service.scrape(input({ resultsWanted: 2 }));
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(retried.jobs).toHaveLength(2);
    });

    it('a geo-blocked session also starts the memo', async () => {
      const { service } = newService(T0);
      mockPost.mockRejectedValueOnce(cfWaf());
      await service.scrape(input());

      await service.scrape(input());

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it(`${ZIPRECRUITER_GEO_BLOCK_TTL_ENV}=0 turns the memo off`, async () => {
      process.env[ZIPRECRUITER_GEO_BLOCK_TTL_ENV] = '0';
      const { service } = newService(T0);
      mockGet.mockRejectedValueOnce(cfWaf()).mockRejectedValueOnce(cfWaf());

      await service.scrape(input());
      const second = await service.scrape(input());

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(second.diagnostics?.detail).not.toMatch(/not retried until/);
    });

    it('keeps the memo bounded', async () => {
      const { service } = newService(T0);
      mockGet.mockRejectedValue(cfWaf());
      for (let i = 0; i < GEO_BLOCK_MEMO_MAX_ENTRIES + 10; i++) {
        await service.scrape(input({ proxies: [`http://p:${i}`] }));
      }
      const memo = (service as unknown as { geoBlockedUntil: Map<string, number> }).geoBlockedUntil;

      expect(memo.size).toBe(GEO_BLOCK_MEMO_MAX_ENTRIES);
      // The newest egress is remembered; the oldest was evicted.
      expect(memo.has(JSON.stringify([`http://p:${GEO_BLOCK_MEMO_MAX_ENTRIES + 9}`]))).toBe(true);
      expect(memo.has(JSON.stringify(['http://p:0']))).toBe(false);
    });

    it('a plain 403 is blocked but not memoised', async () => {
      const { service } = newService(T0);
      mockGet.mockRejectedValueOnce(httpError(403, { error_code: 'forbidden' }));
      const first = await service.scrape(input());

      mockGet.mockResolvedValueOnce(ok(page1()));
      const second = await service.scrape(input({ resultsWanted: 2 }));

      expect(first.diagnostics?.reason).toBe('blocked');
      expect(first.diagnostics?.detail).not.toMatch(/cf-waf/);
      expect(second.jobs).toHaveLength(2);
    });

    it('a 429 is a fetch_error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status code 429'));
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('returns page 1 jobs with diagnostics when page 2 fails (partial)', async () => {
      mockGet.mockResolvedValueOnce(ok(page1())).mockRejectedValueOnce(httpError(500, 'server error'));
      const { service } = newService();

      const result = await service.scrape(input({ resultsWanted: 10 }));

      expect(result.jobs).toHaveLength(2);
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(result.diagnostics?.detail).toContain('500');
    });

    it('a page of records with no usable id is not a silent zero', async () => {
      mockGet.mockResolvedValueOnce(ok({ jobs: [{ name: 'a' }, { name: 'b' }, null] }));
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toMatch(/listing_key/);
    });

    it('a challenge page instead of JSON is blocked', async () => {
      mockGet.mockResolvedValueOnce(ok('<html><title>Just a moment...</title></html>'));
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('any other non-JSON body is reported, not swallowed', async () => {
      mockGet.mockResolvedValueOnce(ok('<html>maintenance</html>'));
      const { service } = newService();

      const result = await service.scrape(input());

      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toMatch(/non-JSON/);
    });
  });

  describe('helpers', () => {
    it('isGeoBlockError recognises the cf-waf body only on a 403', () => {
      expect(isGeoBlockError(cfWaf())).toBe(true);
      expect(isGeoBlockError(httpError(403, JSON.stringify(cfWafBody())))).toBe(true);
      expect(isGeoBlockError(httpError(403, 'error code: forbidden cf-waf'))).toBe(true);
      expect(isGeoBlockError(httpError(403, { error_code: 'forbidden' }))).toBe(false);
      expect(isGeoBlockError(httpError(401, cfWafBody()))).toBe(false);
      expect(isGeoBlockError(new Error('Request failed with status code 403'))).toBe(false);
      expect(isGeoBlockError(null)).toBe(false);
    });

    it('resolveZipRecruiterOptions: defaults and overrides', () => {
      expect(resolveZipRecruiterOptions({})).toEqual({
        regionGuard: true,
        geoBlockTtlMs: GEO_BLOCK_TTL_MS,
        maxPages: null,
        legacyParams: false,
        hoursFilter: true,
        sessionEvent: 'json',
      });
      expect(resolveZipRecruiterOptions({ [ZIPRECRUITER_SESSION_EVENT_ENV]: ' Form ' }).sessionEvent).toBe('form');
      expect(resolveZipRecruiterOptions({ [ZIPRECRUITER_SESSION_EVENT_ENV]: 'off' }).sessionEvent).toBe('off');
      expect(resolveZipRecruiterOptions({ [ZIPRECRUITER_SESSION_EVENT_ENV]: 'weird' }).sessionEvent).toBe('json');
      // Legacy mode keeps the JSON event even when the form one is asked for.
      expect(
        resolveZipRecruiterOptions({
          [ZIPRECRUITER_SESSION_EVENT_ENV]: 'form',
          [ZIPRECRUITER_LEGACY_PARAMS_ENV]: 'true',
        }).sessionEvent,
      ).toBe('json');
      expect(
        resolveZipRecruiterOptions({
          [ZIPRECRUITER_REGION_GUARD_ENV]: 'off',
          [ZIPRECRUITER_GEO_BLOCK_TTL_ENV]: '60000',
          [ZIPRECRUITER_MAX_PAGES_ENV]: '25',
          [ZIPRECRUITER_LEGACY_PARAMS_ENV]: 'YES',
          [ZIPRECRUITER_HOURS_FILTER_ENV]: '0',
        }),
      ).toEqual({
        regionGuard: false,
        geoBlockTtlMs: 60000,
        maxPages: 25,
        legacyParams: true,
        hoursFilter: false,
        sessionEvent: 'json',
      });
      // Junk falls back to the defaults.
      expect(
        resolveZipRecruiterOptions({
          [ZIPRECRUITER_GEO_BLOCK_TTL_ENV]: '-5',
          [ZIPRECRUITER_MAX_PAGES_ENV]: '0',
          [ZIPRECRUITER_LEGACY_PARAMS_ENV]: 'maybe',
        }),
      ).toEqual(expect.objectContaining({ geoBlockTtlMs: GEO_BLOCK_TTL_MS, maxPages: null, legacyParams: false }));
    });
  });
});
