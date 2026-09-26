import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Country, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { createHttpClient } from '@ever-jobs/common';
import { BaytService } from '../src/bayt.service';
import {
  BAYT_DELAY_MAX_MS,
  BAYT_DELAY_MIN_MS,
  BAYT_ENV,
  BAYT_MAX_PAGES,
} from '../src/bayt.constants';

const FIX = join(__dirname, 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf-8');

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

type Reply = string | Error | ((url: string) => string | Error);

/** Serve fixtures by page number (`?page=N`), any other page answers `fallback`. */
function routePages(pages: Record<number, Reply>, fallback: Reply = fixture('listing-empty.html')) {
  mockGet.mockImplementation((url: string) => {
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '0');
    let reply = pages[page] ?? fallback;
    if (typeof reply === 'function') reply = reply(url);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ status: 200, data: reply });
  });
}

function httpError(status: number, headers: Record<string, unknown> = {}, data = ''): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers, data },
  });
}

/** A listing page whose cards carry ids `from..from+count-1`. */
function freshPage(from: number, count = 2): string {
  const cards = Array.from({ length: count }, (_, i) => {
    const id = from + i;
    return `<li data-js-job="" data-job-id="${id}"><h2><a href="/en/uae/jobs/job-${id}/">Job ${id}</a></h2></li>`;
  });
  return `<html><body><ul>${cards.join('')}</ul></body></html>`;
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.BAYT],
    searchTerm: 'python developer',
    resultsWanted: 50,
    ...overrides,
  });
}

const requestedUrls = (): string[] => mockGet.mock.calls.map((c) => c[0] as string);

describe('BaytService (Spec 1710)', () => {
  let service: BaytService;
  let nowSpy: jest.SpyInstance;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockRandomSleep.mockClear();
    (createHttpClient as jest.Mock).mockClear();
    for (const key of Object.values(BAYT_ENV)) delete process.env[key];
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    service = new BaytService();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...savedEnv };
  });

  describe('transport', () => {
    it('forwards requestTimeout and userAgent even when proxies are set (not the dropped `timeout` key)', async () => {
      routePages({});
      await service.scrape(
        input({
          proxies: ['http://p:1'],
          caCert: '/tmp/ca.pem',
          requestTimeout: 30,
          userAgent: 'EverJobs-Test/1.0',
        }),
      );
      expect(createHttpClient).toHaveBeenCalledWith({
        proxies: ['http://p:1'],
        caCert: '/tmp/ca.pem',
        requestTimeout: 30,
        userAgent: 'EverJobs-Test/1.0',
      });
      const arg = (createHttpClient as jest.Mock).mock.calls[0][0];
      expect(arg).not.toHaveProperty('timeout');
    });

    it('asks for HTML in English and sets no User-Agent of its own', async () => {
      routePages({});
      await service.scrape(input());
      expect(mockSetHeaders).toHaveBeenCalledTimes(1);
      const headers = mockSetHeaders.mock.calls[0][0] as Record<string, string>;
      expect(headers.Accept).toContain('text/html');
      expect(headers['Accept-Language']).toMatch(/^en/);
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
      expect(Object.keys(headers).some((k) => /^sec-/i.test(k))).toBe(false);
    });
  });

  describe('search URL', () => {
    it('normalises the slug (accents folded, whitespace collapsed)', async () => {
      routePages({});
      await service.scrape(input({ searchTerm: 'Ingénieur  Logiciel' }));
      expect(requestedUrls()[0]).toBe(
        'https://www.bayt.com/en/international/jobs/ingenieur-logiciel-jobs/?page=1',
      );
    });

    it('scopes the path by a Bayt-market country', async () => {
      routePages({});
      await service.scrape(input({ country: Country.UNITEDARABEMIRATES }));
      expect(requestedUrls()[0]).toBe(
        'https://www.bayt.com/en/uae/jobs/python-developer-jobs/?page=1',
      );
    });

    it('scopes the path by location when country is the DTO default', async () => {
      routePages({});
      await service.scrape(input({ location: 'Riyadh, Saudi Arabia' }));
      expect(requestedUrls()[0]).toContain('/en/saudi-arabia/jobs/python-developer-jobs/');
    });

    it('keeps /en/international/ for the DTO default country', async () => {
      routePages({});
      await service.scrape(input());
      expect(requestedUrls()[0]).toContain('/en/international/jobs/');
    });

    it('browses the market with no search term', async () => {
      routePages({});
      await service.scrape(input({ searchTerm: undefined, country: Country.QATAR }));
      expect(requestedUrls()[0]).toBe('https://www.bayt.com/en/qatar/jobs/?page=1');
    });

    it('returns bad_input and sends no request for a term with no usable slug', async () => {
      routePages({});
      const res = await service.scrape(input({ searchTerm: 'مهندس' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toMatch(/no ASCII letters or digits/);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('never requests a robots-disallowed path', async () => {
      routePages({ 1: freshPage(7000000, 2) }, freshPage(7100000, 2));
      await service.scrape(input({ searchTerm: 'C++ / filters[x]', resultsWanted: 4 }));
      for (const url of requestedUrls()) {
        const { pathname, search } = new URL(url);
        expect(pathname.startsWith('/en/jobs/')).toBe(false);
        expect(`${pathname}${search}`).not.toMatch(/filters\[|filters%5|options\[|options%5/i);
        expect(search).toMatch(/^\?page=\d+$/);
      }
    });
  });

  describe('mapping', () => {
    it('maps page 1: stable ids, canonical URLs, collapsed titles, split locations', async () => {
      routePages({ 1: fixture('listing-page1.html') });
      const res = await service.scrape(input());

      expect(res.jobs.map((j) => j.id)).toEqual(['bayt-5123456', 'bayt-5123457', 'bayt-5123458']);
      for (const job of res.jobs) {
        expect(job.site).toBe(Site.BAYT);
        expect(job.jobUrl).toMatch(/^https:\/\/www\.bayt\.com\/en\//);
        expect(job.jobUrl).not.toContain('?');
        expect(job.jobUrl.match(/https?:\/\//g)).toHaveLength(1);
        expect(job.title).not.toMatch(/\s{2,}|^\s|\s$/);
      }
      const [dubai, riyadh, amman] = res.jobs;
      expect(dubai.title).toBe('Senior Python Developer');
      expect(dubai.location).toMatchObject({ city: 'Dubai', country: 'United Arab Emirates' });
      expect(riyadh.location).toMatchObject({ city: 'Riyadh', country: 'Saudi Arabia' });
      expect(amman.location).toMatchObject({ city: 'Amman', country: 'Jordan' });
      expect(dubai.companyUrl).toBe('https://www.bayt.com/en/company/acme-labs-1001/');
      expect(dubai.datePosted).toBe('2026-09-24');
      expect(riyadh.datePosted).toBe('2026-09-21');
      expect(amman.datePosted).toBeNull();
      // Page 1 then the empty default page: no diagnostic.
      expect(res.diagnostics).toBeUndefined();
    });

    it('keeps the pre-1710 mapping reachable via EVER_JOBS_BAYT_LEGACY_MAPPING', async () => {
      process.env[BAYT_ENV.legacyMapping] = 'true';
      routePages({ 1: fixture('listing-page1.html') });
      const res = await service.scrape(input());
      expect(res.jobs).toHaveLength(3);
      expect(res.jobs[0].jobUrl).toBe(
        'https://www.bayt.com/en/uae/jobs/senior-python-developer-5123456/?utm_source=list',
      );
      expect(res.jobs[0].id).toMatch(/^bayt-\d+$/);
      expect(res.jobs[0].id).not.toBe('bayt-5123456');
      expect(res.jobs[0].location).toMatchObject({
        city: 'Dubai · United Arab Emirates',
        country: Country.WORLDWIDE,
      });
    });

    it('keeps the pre-1710 slug and the international-only path reachable', async () => {
      routePages({});
      await service.scrape(
        input({ searchTerm: 'Python Developer', country: Country.UNITEDARABEMIRATES }),
        { legacySlug: true, countryScope: false },
      );
      expect(requestedUrls()[0]).toBe(
        'https://www.bayt.com/en/international/jobs/Python-Developer-jobs/?page=1',
      );
    });

    it('sets isRemote from the location text without filtering', async () => {
      const html = `<ul>
        <li data-js-job="" data-job-id="5200001"><h2><a href="/en/uae/jobs/a-5200001/">A</a></h2>
          <div class="t-mute t-small">Remote</div></li>
        <li data-js-job="" data-job-id="5200002"><h2><a href="/en/uae/jobs/b-5200002/">B</a></h2>
          <div class="t-mute t-small">Dubai, United Arab Emirates</div></li></ul>`;
      routePages({ 1: html });
      const res = await service.scrape(input({ isRemote: true }));
      expect(res.jobs).toHaveLength(2);
      expect(res.jobs[0].isRemote).toBe(true);
      expect(res.jobs[0].workFromHomeType).toBe('Remote');
      expect(res.jobs[0].location).toBeNull();
      expect(res.jobs[1].isRemote).toBeNull();
    });
  });

  describe('pagination', () => {
    it('dedupes ids across pages and stops on a page that adds nothing new', async () => {
      routePages({
        1: fixture('listing-page1.html'),
        2: fixture('listing-page2-repeat.html'),
        3: fixture('listing-page2-repeat.html'),
      }, freshPage(9000000));
      const res = await service.scrape(input());

      const ids = res.jobs.map((j) => j.id);
      expect(ids).toEqual(['bayt-5123456', 'bayt-5123457', 'bayt-5123458', 'bayt-5123460']);
      expect(new Set(ids).size).toBe(ids.length);
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(res.diagnostics).toBeUndefined();
    });

    it('pauses between pages, never before the first', async () => {
      routePages({
        1: fixture('listing-page1.html'),
        2: fixture('listing-page2-repeat.html'),
      });
      await service.scrape(input());
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(mockRandomSleep).toHaveBeenCalledTimes(2);
      expect(mockRandomSleep).toHaveBeenCalledWith(BAYT_DELAY_MIN_MS, BAYT_DELAY_MAX_MS);
    });

    it('fetches pages strictly one at a time', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      let next = 8000000;
      mockGet.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        const html = freshPage(next);
        next += 2;
        return { status: 200, data: html };
      });
      await service.scrape(input({ resultsWanted: 8 }));
      expect(mockGet).toHaveBeenCalledTimes(4);
      expect(maxInFlight).toBe(1);
    });

    it('honours offset over unique jobs', async () => {
      routePages({
        1: fixture('listing-page1.html'),
        2: fixture('listing-page2-repeat.html'),
      });
      const res = await service.scrape(input({ offset: 2, resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.id)).toEqual(['bayt-5123458', 'bayt-5123460']);
      expect(requestedUrls()[0]).toMatch(/\?page=1$/);
    });

    it('stops at resultsWanted without fetching another page', async () => {
      routePages({ 1: fixture('listing-page1.html') }, freshPage(9100000));
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.id)).toEqual(['bayt-5123456', 'bayt-5123457']);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('defaults resultsWanted to 15 when the caller leaves it unset', async () => {
      let next = 8500000;
      mockGet.mockImplementation(async () => {
        const html = freshPage(next, 10);
        next += 10;
        return { status: 200, data: html };
      });
      const res = await service.scrape({
        siteType: [Site.BAYT],
        searchTerm: 'python',
      } as ScraperInputDto);
      expect(res.jobs).toHaveLength(15);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('caps the page count', async () => {
      let next = 6000000;
      mockGet.mockImplementation(async () => {
        const html = freshPage(next);
        next += 2;
        return { status: 200, data: html };
      });
      const res = await service.scrape(input({ resultsWanted: 1000 }));
      expect(mockGet).toHaveBeenCalledTimes(BAYT_MAX_PAGES);
      expect(res.jobs).toHaveLength(BAYT_MAX_PAGES * 2);
    });

    it('takes the page cap from EVER_JOBS_BAYT_MAX_PAGES', async () => {
      process.env[BAYT_ENV.maxPages] = '3';
      let next = 6100000;
      mockGet.mockImplementation(async () => {
        const html = freshPage(next);
        next += 2;
        return { status: 200, data: html };
      });
      await service.scrape(input({ resultsWanted: 1000 }));
      expect(mockGet).toHaveBeenCalledTimes(3);
    });
  });

  describe('diagnostics', () => {
    it('reports a challenge served with HTTP 200 as blocked, not an empty board', async () => {
      routePages({ 1: fixture('challenge.html') });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(res.diagnostics?.detail).toBe('bayt.com served a bot challenge page with HTTP 200');
    });

    it('names the managed challenge on a 403 with cf-mitigated: challenge', async () => {
      routePages({ 1: httpError(403, { 'cf-mitigated': 'challenge' }, fixture('challenge.html')) });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(res.diagnostics?.detail).toMatch(/managed challenge.*HTTP 403.*cf-mitigated: challenge/);
    });

    it('returns the jobs collected so far with blocked when a later page is challenged', async () => {
      routePages({
        1: fixture('listing-page1.html'),
        2: httpError(403, { 'cf-mitigated': 'challenge' }),
      });
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.id)).toEqual(['bayt-5123456', 'bayt-5123457', 'bayt-5123458']);
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('classifies any other error with the shared classifier', async () => {
      routePages({ 1: httpError(404) });
      const res = await service.scrape(input({ country: Country.MOROCCO }));
      expect(res.diagnostics?.reason).toBe('bad_input');
    });

    it('returns no diagnostic for a genuinely empty board', async () => {
      routePages({ 1: fixture('listing-empty.html') });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('reports markup drift when cards exist but none parse', async () => {
      routePages({ 1: fixture('listing-all-broken.html') });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('unknown');
      expect(res.diagnostics?.detail).toBe(
        '2 cards on page 1, none parsed: listing markup changed?',
      );
    });

    it('refuses a legacy slug that would spell a robots-disallowed filter, with no request', async () => {
      const res = await service.scrape(input({ searchTerm: 'x filters[a]' }), { legacySlug: true });
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toMatch(/robots-disallowed/);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('hoursOld (client-side)', () => {
    it('drops cards known to be older and keeps undated ones', async () => {
      routePages({ 1: fixture('listing-page1.html') });
      const res = await service.scrape(input({ hoursOld: 48 }));
      // Today kept, "3 days ago" dropped, the undated Amman card kept.
      expect(res.jobs.map((j) => j.id)).toEqual(['bayt-5123456', 'bayt-5123458']);
      // No server-side filter parameter is ever sent.
      for (const url of requestedUrls()) expect(new URL(url).search).toMatch(/^\?page=\d+$/);
    });

    it('keeps everything when hoursOld is wide enough', async () => {
      routePages({ 1: fixture('listing-page1.html') });
      const res = await service.scrape(input({ hoursOld: 24 * 4 }));
      expect(res.jobs).toHaveLength(3);
    });
  });
});
