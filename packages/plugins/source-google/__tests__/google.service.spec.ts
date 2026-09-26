/**
 * Spec 1704 — GoogleService read path, against synthetic fixtures.
 *
 * The HTTP factory and the inter-page sleep are mocked, so nothing here
 * touches the network. The live smoke test is google.e2e-spec.ts, which is
 * opt-in (RUN_NETWORK_E2E).
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockRandomSleep = jest.fn(() => Promise.resolve());
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
    randomSleep: (...args: unknown[]) => mockRandomSleep(...(args as [])),
  };
});

import {
  GOOGLE_CURSOR_NO_RECORDS_DETAIL,
  GOOGLE_LEGACY_PARSER_ENV,
  GOOGLE_MAX_PAGES_ENV,
  GOOGLE_ZERO_YIELD_DETAIL,
  GoogleModule,
  GoogleService,
} from '../src';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const INITIAL = fixture('google-initial.html');
const INITIAL_NO_CURSOR = INITIAL.replace(/<div jsname="Yust4d"[^>]*><\/div>/, '');
const ROTATED = fixture('google-initial-rotated-key.html');
const PAGE_2 = fixture('google-page-2.html');
const SORRY = fixture('google-sorry.html');
const ENABLEJS = fixture('google-enablejs.html');
const EMPTY = fixture('google-empty-results.html');

const ACME_URL = 'https://jobs.acme.example/postings/sre-001';
const BETA_URL = 'https://careers.beta.example/openings/42';

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    siteType: [Site.GOOGLE],
    searchTerm: 'devops engineer',
    location: 'Chicago',
    resultsWanted: 15,
    ...overrides,
  } as ScraperInputDto;
}

function axiosError(message: string, response?: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { response?: Record<string, unknown>; isAxiosError?: boolean };
  err.isAxiosError = true;
  if (response) err.response = response;
  return err;
}

const ENV_KEYS = [GOOGLE_LEGACY_PARSER_ENV, GOOGLE_MAX_PAGES_ENV];

describe('Spec 1704 — GoogleService', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let warnSpy: jest.SpyInstance;
  let spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockRandomSleep.mockClear();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spies = [
      warnSpy,
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const spy of spies) spy.mockRestore();
  });

  it('resolves through GoogleModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GoogleModule] }).compile();
    expect(moduleRef.get(GoogleService)).toBeInstanceOf(GoogleService);
    await moduleRef.close();
  });

  describe('record-based rows (the misattribution regression)', () => {
    it('gives each row the URL inside its own record', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      const result = await new GoogleService().scrape(input());

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs.map((j) => [j.title, j.companyName, j.jobUrl])).toEqual([
        ['Site Reliability Engineer', 'Acme Corp', ACME_URL],
        ['Backend Developer', 'Beta Labs', BETA_URL],
      ]);
      expect(result.diagnostics).toBeUndefined();
    });

    it('the legacy index-pairing parser, still reachable, misattributes the same page', async () => {
      process.env[GOOGLE_LEGACY_PARSER_ENV] = 'true';
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR }).mockResolvedValueOnce({ data: EMPTY });
      const result = await new GoogleService().scrape(input());

      const sre = result.jobs.find((j) => j.title === 'Site Reliability Engineer');
      expect(sre).toBeDefined();
      expect(sre!.jobUrl).not.toBe(ACME_URL);
      // UI strings from the page come out as rows too.
      expect(result.jobs.map((j) => j.title)).toContain('Search results');
    });

    it('skips a record without a URL and never builds a search URL', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs.map((j) => j.title)).not.toContain('Data Analyst');
      for (const job of result.jobs) expect(job.jobUrl).not.toContain('google.com/search');
    });

    it('ids are go-<stable id> and identical across scrapes', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR }).mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      const service = new GoogleService();
      const a = (await service.scrape(input())).jobs.map((j) => j.id);
      const b = (await service.scrape(input())).jobs.map((j) => j.id);
      expect(a).toEqual(['go-job-acme-sre-001', 'go-job-beta-backend-042']);
      expect(b).toEqual(a);
    });

    it('fills location from the record, and "Anywhere" as remote', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      const [acme, beta] = (await new GoogleService().scrape(input())).jobs;

      expect(acme.location).toMatchObject({ city: 'Austin', state: 'TX', country: 'United States' });
      expect(acme.isRemote).toBeUndefined();
      expect(beta.isRemote).toBe(true);
      expect(beta.workFromHomeType).toBe('Remote');
      expect(beta.location?.city).toBeUndefined();
      expect(beta.site).toBe(Site.GOOGLE);
    });

    it('reads a rotated payload key and warns with the key', async () => {
      mockGet.mockResolvedValueOnce({ data: ROTATED });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs.map((j) => j.jobUrl)).toEqual([ACME_URL, BETA_URL]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('987654321'));
    });

    it('respects resultsWanted on the first page', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL });
      const result = await new GoogleService().scrape(input({ resultsWanted: 1 }));
      expect(result.jobs.map((j) => j.id)).toEqual(['go-job-acme-sre-001']);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('request', () => {
    it('sends the same query and parameters as before', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      await new GoogleService().scrape(input({ isRemote: true }));

      expect(mockGet).toHaveBeenCalledWith('https://www.google.com/search', {
        params: { q: 'devops engineer jobs near Chicago remote', ibp: 'htl;jobs', hl: 'en' },
      });
    });

    it('googleSearchTerm still overrides searchTerm', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      await new GoogleService().scrape(input({ googleSearchTerm: 'rust developer', location: undefined }));
      expect(mockGet.mock.calls[0][1].params.q).toBe('rust developer jobs');
    });
  });

  describe('pagination gate', () => {
    it('does not paginate when the first page has no forward cursor', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL_NO_CURSOR });
      await new GoogleService().scrape(input());

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).not.toHaveBeenCalled();
    });

    it('with a cursor, runs the existing loop, dedupes by id and stops on a page with no new rows', async () => {
      mockGet
        .mockResolvedValueOnce({ data: INITIAL })
        .mockResolvedValueOnce({ data: PAGE_2 })
        .mockResolvedValueOnce({ data: PAGE_2 });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs.map((j) => j.id)).toEqual([
        'go-job-acme-sre-001',
        'go-job-beta-backend-042',
        'go-job-delta-platform-077',
        'go-job-epsilon-qa-005',
      ]);
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(mockRandomSleep).toHaveBeenCalledTimes(2);
      expect(mockGet.mock.calls[1][1].params).toMatchObject({ start: 10, asearch: 'jbs', ibp: 'htl;jobs' });
      expect(mockGet.mock.calls[2][1].params).toMatchObject({ start: 20 });
      expect(result.diagnostics).toBeUndefined();
    });

    it('stops at resultsWanted mid-page', async () => {
      mockGet.mockResolvedValueOnce({ data: INITIAL }).mockResolvedValueOnce({ data: PAGE_2 });
      const result = await new GoogleService().scrape(input({ resultsWanted: 3 }));

      expect(result.jobs.map((j) => j.id)).toEqual([
        'go-job-acme-sre-001',
        'go-job-beta-backend-042',
        'go-job-delta-platform-077',
      ]);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('caps follow-up requests at EVER_JOBS_GOOGLE_MAX_PAGES', async () => {
      process.env[GOOGLE_MAX_PAGES_ENV] = '1';
      mockGet.mockResolvedValueOnce({ data: INITIAL }).mockResolvedValue({ data: PAGE_2 });
      await new GoogleService().scrape(input({ resultsWanted: 100 }));

      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('caps follow-up requests at the default when pages keep producing rows', async () => {
      let n = 0;
      mockGet.mockImplementation(() => {
        n++;
        if (n === 1) return Promise.resolve({ data: INITIAL });
        return Promise.resolve({ data: PAGE_2.replace(/job-delta-platform-077/g, `job-delta-${n}`) });
      });
      await new GoogleService().scrape(input({ resultsWanted: 1000 }));

      expect(mockGet).toHaveBeenCalledTimes(1 + 10);
    });
  });

  describe('diagnostics', () => {
    it('an interstitial first page is blocked, not a silent []', async () => {
      for (const data of [SORRY, ENABLEJS]) {
        mockGet.mockReset();
        mockGet.mockResolvedValueOnce({ data });
        const result = await new GoogleService().scrape(input());
        expect(result.jobs).toEqual([]);
        expect(result.diagnostics?.reason).toBe('blocked');
      }
    });

    it('a first page redirected to /sorry/ is blocked', async () => {
      mockGet.mockResolvedValueOnce({
        data: '<html><body>redirected</body></html>',
        status: 200,
        request: { res: { responseUrl: 'https://www.google.com/sorry/index?continue=x' } },
      });
      const result = await new GoogleService().scrape(input());
      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('a results page with no payload and no cursor is unknown, with the reason', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toEqual(expect.objectContaining({ reason: 'unknown', detail: GOOGLE_ZERO_YIELD_DETAIL }));
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('a cursor with no records, then an empty follow-up page, is unknown', async () => {
      mockGet
        .mockResolvedValueOnce({ data: `${EMPTY}<div jsname="Yust4d" data-async-fc="C"></div>` })
        .mockResolvedValueOnce({ data: EMPTY });
      const result = await new GoogleService().scrape(input());

      expect(result.diagnostics).toEqual(
        expect.objectContaining({ reason: 'unknown', detail: GOOGLE_CURSOR_NO_RECORDS_DETAIL }),
      );
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('follow-up pages failing after page-1 rows is partial, with those rows kept', async () => {
      mockGet
        .mockResolvedValueOnce({ data: INITIAL })
        .mockRejectedValue(axiosError('Request failed with status code 503'));
      const result = await new GoogleService().scrape(input());

      expect(result.jobs.map((j) => j.id)).toEqual(['go-job-acme-sre-001', 'go-job-beta-backend-042']);
      expect(result.diagnostics?.reason).toBe('partial');
      expect(result.diagnostics?.detail).toContain('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1 + 3);
    });

    it('one failed follow-up page that later recovers is not reported', async () => {
      mockGet
        .mockResolvedValueOnce({ data: INITIAL })
        .mockRejectedValueOnce(axiosError('socket hang up'))
        .mockResolvedValueOnce({ data: PAGE_2 })
        .mockResolvedValueOnce({ data: EMPTY });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs).toHaveLength(4);
      expect(result.diagnostics).toBeUndefined();
    });

    it('a first-page network error is classified as before', async () => {
      mockGet.mockRejectedValueOnce(axiosError('read ECONNRESET'));
      const result = await new GoogleService().scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('a first-page 429 from the /sorry/ page is blocked', async () => {
      mockGet.mockRejectedValueOnce(
        axiosError('Request failed with status code 429', {
          status: 429,
          data: SORRY,
          request: { res: { responseUrl: 'https://www.google.com/sorry/index?continue=x' } },
        }),
      );
      const result = await new GoogleService().scrape(input());

      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toContain('429');
    });

    it('a first-page 404 without an interstitial keeps its usual classification', async () => {
      mockGet.mockRejectedValueOnce(axiosError('Request failed with status code 404', { status: 404, data: 'nope' }));
      const result = await new GoogleService().scrape(input());
      expect(result.diagnostics?.reason).toBe('bad_input');
    });
  });

  describe('legacy path (EVER_JOBS_GOOGLE_LEGACY_PARSER)', () => {
    beforeEach(() => {
      process.env[GOOGLE_LEGACY_PARSER_ENV] = '1';
    });

    it('keeps the old silent [] and the ungated loop', async () => {
      mockGet.mockResolvedValueOnce({ data: EMPTY }).mockResolvedValueOnce({ data: EMPTY });
      const result = await new GoogleService().scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeUndefined();
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('still classifies a first-page error', async () => {
      mockGet.mockRejectedValueOnce(axiosError('read ECONNRESET'));
      const result = await new GoogleService().scrape(input());
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('is also bounded by the page cap', async () => {
      process.env[GOOGLE_MAX_PAGES_ENV] = '2';
      mockGet.mockResolvedValue({ data: INITIAL });
      await new GoogleService().scrape(input({ resultsWanted: 1000 }));
      expect(mockGet).toHaveBeenCalledTimes(1 + 2);
    });
  });
});
