import 'reflect-metadata';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn();
const mockRandomSleep = jest.fn();
const mockGetPage = jest.fn();
const mockBrowserClose = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args),
  randomSleep: (...args: unknown[]) => mockRandomSleep(...args),
  BrowserPool: {
    getPage: (...args: unknown[]) => mockGetPage(...args),
    close: (...args: unknown[]) => mockBrowserClose(...args),
  },
}));

import { JobType, ScraperInputDto } from '@ever-jobs/models';
import {
  WELLFOUND_DELAY_MAX,
  WELLFOUND_DELAY_MIN,
  WELLFOUND_FETCH_MODE_ENV,
  WELLFOUND_MAX_PAGES,
  WELLFOUND_ROUTE_MODE_ENV,
  WELLFOUND_USER_AGENT,
  WellfoundService,
} from '../src';
import { htmlPage, landingPayload, LandingOptions, loadJsonFixture, readFixture } from './fixtures/builders';

/**
 * Spec 1708: the Wellfound aggregator search over plain HTTP, with every
 * network edge mocked (HTTP client, browser pool, inter-page sleep).
 */

type Reply = { status: number; data: string } | Error;

const BASE = 'https://wellfound.com';
const page = (options: LandingOptions, html: { beacon?: boolean } = {}): Reply => ({
  status: 200,
  data: htmlPage(landingPayload(options), html),
});
const notFound = (): Reply => ({ status: 404, data: '<html><body>Not found</body></html>' });

/** Route GETs by URL; anything unrouted is a 404. */
function routeHttp(routes: Record<string, Reply>): void {
  mockGet.mockImplementation(async (url: string) => {
    const reply = routes[url] ?? notFound();
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

const requestedUrls = (): string[] => mockGet.mock.calls.map((c) => c[0] as string);

const input = (partial: Partial<ScraperInputDto> = {}): ScraperInputDto =>
  new ScraperInputDto({ resultsWanted: 15, ...partial } as ScraperInputDto);

const ids = (jobs: { id?: string | null }[]): string[] => jobs.map((j) => String(j.id).replace('wellfound-', ''));

describe('WellfoundService (Spec 1708)', () => {
  let service: WellfoundService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReset();
    mockCreateHttpClient.mockImplementation(() => ({ get: mockGet, setHeaders: mockSetHeaders }));
    mockRandomSleep.mockResolvedValue(undefined);
    mockGetPage.mockRejectedValue(new Error('browser must not be used'));
    delete process.env[WELLFOUND_FETCH_MODE_ENV];
    delete process.env[WELLFOUND_ROUTE_MODE_ENV];
    service = new WellfoundService();
  });

  afterAll(() => {
    delete process.env[WELLFOUND_FETCH_MODE_ENV];
    delete process.env[WELLFOUND_ROUTE_MODE_ENV];
  });

  describe('happy path over HTTP', () => {
    it('returns jobs from one GET without the browser or diagnostics', async () => {
      const nd = loadJsonFixture('role-location.p1.json');
      routeHttp({ [`${BASE}/role/l/software-engineer/san-francisco`]: { status: 200, data: htmlPage(nd) } });

      const res = await service.scrape(input({ searchTerm: 'Software Engineer', location: 'San Francisco, CA', resultsWanted: 5 }));

      expect(res.jobs).toHaveLength(5);
      expect(ids(res.jobs)).toEqual(['800011', '800021', '800022', '800023', '800031']);
      expect(res.jobs[0]).toMatchObject({
        companyName: 'Harborlight Analytics',
        jobUrl: 'https://wellfound.com/jobs/800011-associate-software-engineer',
        datePosted: '2026-09-22',
      });
      expect(res.diagnostics).toBeUndefined();
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGetPage).not.toHaveBeenCalled();
      expect(mockRandomSleep).not.toHaveBeenCalled();
    });

    it('sends the honest UA, pins redirects and lets 403/404 through for classification', async () => {
      routeHttp({ [`${BASE}/role/software-engineer`]: page({ startups: [{ id: '1', listings: ['a'] }] }) });

      await service.scrape(input({ searchTerm: 'software engineer' }));

      const options = mockCreateHttpClient.mock.calls[0][0];
      expect(options.userAgent).toBe(WELLFOUND_USER_AGENT);
      expect(options.allowedRedirectHosts).toEqual(['wellfound.com']);
      expect(mockSetHeaders).toHaveBeenCalledWith(expect.objectContaining({ Accept: 'text/html,application/xhtml+xml' }));
      const config = mockGet.mock.calls[0][1];
      expect(config.responseType).toBe('text');
      expect(config.validateStatus(200)).toBe(true);
      expect(config.validateStatus(403)).toBe(true);
      expect(config.validateStatus(404)).toBe(true);
      expect(config.validateStatus(429)).toBe(false);
      expect(config.validateStatus(503)).toBe(false);
    });

    it('a caller-supplied userAgent still wins', async () => {
      routeHttp({ [`${BASE}/jobs`]: page({ startups: [{ id: '1', listings: ['a'] }] }) });
      await service.scrape(input({ userAgent: 'CallerBot/2.0' }));
      expect(mockCreateHttpClient.mock.calls[0][0].userAgent).toBe('CallerBot/2.0');
    });

    it('passes the full proxies array to the HTTP client (regression: only proxies[0] was used)', async () => {
      routeHttp({ [`${BASE}/jobs`]: page({ startups: [{ id: '1', listings: ['a'] }] }) });
      await service.scrape(input({ proxies: ['http://p1:8080', 'http://p2:8080', 'http://p3:8080'] }));
      expect(mockCreateHttpClient.mock.calls[0][0].proxies).toEqual(['http://p1:8080', 'http://p2:8080', 'http://p3:8080']);
    });
  });

  describe('pagination', () => {
    it('reads pages sequentially with a polite pause, de-duplicates, and stops at pageCount', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ pageCount: 2, startups: [{ id: '1', listings: ['a', 'b', 'c'] }] }),
        [`${BASE}/role/software-engineer?page=2`]: page({ page: 2, pageCount: 2, startups: [{ id: '1', listings: ['c', 'd'] }] }),
      });
      let inFlight = 0;
      let maxInFlight = 0;
      const routed = mockGet.getMockImplementation()!;
      mockGet.mockImplementation(async (url: string, config: unknown) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await routed(url, config);
        } finally {
          inFlight--;
        }
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 50 }));

      expect(ids(res.jobs)).toEqual(['a', 'b', 'c', 'd']);
      expect(requestedUrls()).toEqual([`${BASE}/role/software-engineer`, `${BASE}/role/software-engineer?page=2`]);
      expect(maxInFlight).toBe(1);
      expect(mockRandomSleep).toHaveBeenCalledTimes(1);
      expect(mockRandomSleep).toHaveBeenCalledWith(WELLFOUND_DELAY_MIN, WELLFOUND_DELAY_MAX);
      expect(res.diagnostics).toBeUndefined();
    });

    it('stops when a page adds no new listing', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ pageCount: 5, startups: [{ id: '1', listings: ['a', 'b'] }] }),
        [`${BASE}/role/software-engineer?page=2`]: page({ page: 2, pageCount: 5, startups: [{ id: '1', listings: ['a', 'b'] }] }),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 50 }));

      expect(ids(res.jobs)).toEqual(['a', 'b']);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it(`never reads more than ${WELLFOUND_MAX_PAGES} pages, even when the site declares 45`, async () => {
      const routes: Record<string, Reply> = {};
      for (let n = 1; n <= 45; n++) {
        const url = n === 1 ? `${BASE}/role/software-engineer` : `${BASE}/role/software-engineer?page=${n}`;
        routes[url] = page({ page: n, pageCount: 45, startups: [{ id: `s${n}`, listings: [`p${n}a`, `p${n}b`] }] });
      }
      routeHttp(routes);

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 1000 }));

      expect(mockGet).toHaveBeenCalledTimes(WELLFOUND_MAX_PAGES);
      expect(res.jobs).toHaveLength(WELLFOUND_MAX_PAGES * 2);
      expect(mockRandomSleep).toHaveBeenCalledTimes(WELLFOUND_MAX_PAGES - 1);
    });

    it('stops as soon as offset + resultsWanted listings matched', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ pageCount: 3, startups: [{ id: '1', listings: ['a', 'b'] }] }),
        [`${BASE}/role/software-engineer?page=2`]: page({ page: 2, pageCount: 3, startups: [{ id: '2', listings: ['c', 'd'] }] }),
        [`${BASE}/role/software-engineer?page=3`]: page({ page: 3, pageCount: 3, startups: [{ id: '3', listings: ['e'] }] }),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 2, offset: 1 }));

      expect(ids(res.jobs)).toEqual(['b', 'c']);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('a failure on page 2 keeps the page-1 jobs and reports partial', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ pageCount: 3, startups: [{ id: '1', listings: ['a', 'b'] }] }),
        [`${BASE}/role/software-engineer?page=2`]: new Error('Request failed with status code 503'),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 10 }));

      expect(ids(res.jobs)).toEqual(['a', 'b']);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('fetch_error');
    });

    it('a challenge on page 2 keeps the page-1 jobs and reports partial', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ pageCount: 3, startups: [{ id: '1', listings: ['a'] }] }),
        [`${BASE}/role/software-engineer?page=2`]: { status: 403, data: readFixture('interstitial.synthetic.html') },
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 10 }));

      expect(ids(res.jobs)).toEqual(['a']);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('blocked');
    });

    it('a page-2 failure with nothing matched yet reports the failure itself', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({
          pageCount: 3,
          startups: [{ id: '1', listings: ['a'] }],
          listings: { a: { jobType: 'part-time' } },
        }),
        [`${BASE}/role/software-engineer?page=2`]: new Error('socket hang up'),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', jobType: JobType.FULL_TIME }));

      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });
  });

  describe('challenge handling', () => {
    it('a 200 page carrying the CDN beacon and a valid payload is data, not a challenge (regression)', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({ startups: [{ id: '1', listings: ['a', 'b'] }] }, { beacon: true }),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer' }));

      expect(ids(res.jobs)).toEqual(['a', 'b']);
      expect(res.diagnostics).toBeUndefined();
      expect(mockGetPage).not.toHaveBeenCalled();
    });

    it('a 403 interstitial is reported as blocked and never worked around with a browser', async () => {
      routeHttp({ [`${BASE}/role/software-engineer`]: { status: 403, data: readFixture('interstitial.synthetic.html') } });

      const res = await service.scrape(input({ searchTerm: 'software engineer' }));

      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(res.diagnostics?.detail).toContain('403');
      expect(mockGetPage).not.toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('a 200 interstitial without payload is blocked too', async () => {
      routeHttp({ [`${BASE}/jobs`]: { status: 200, data: readFixture('interstitial.synthetic.html') } });
      const res = await service.scrape(input({}));
      expect(res.diagnostics?.reason).toBe('blocked');
    });
  });

  describe('fallback chain', () => {
    it('a 404 role/location page falls back to the role page with a local location filter', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({
          startups: [{ id: '1', listings: ['sf', 'tor', 'nyc'] }],
          listings: {
            sf: { locationNames: ['San Francisco'] },
            tor: { locationNames: ['Toronto'] },
            nyc: { locationNames: ['New York City'], acceptedRemoteLocationNames: [] },
          },
        }),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', location: 'Toronto, ON' }));

      expect(requestedUrls()).toEqual([`${BASE}/role/l/software-engineer/toronto`, `${BASE}/role/software-engineer`]);
      expect(ids(res.jobs)).toEqual(['tor']);
    });

    it('a not-found page (/_error) moves on to the next route', async () => {
      const errorPage = { page: '/_error', query: {}, props: { pageProps: { statusCode: 404 } } };
      routeHttp({
        [`${BASE}/role/data-wrangler`]: { status: 200, data: htmlPage(errorPage) },
        [`${BASE}/jobs`]: page({
          startups: [{ id: '1', listings: ['x', 'y'] }],
          listings: { x: { title: 'Data Wrangler' }, y: { title: 'Designer' } },
          roleKeyword: null,
        }),
      });

      const res = await service.scrape(input({ searchTerm: 'data wrangler' }));

      expect(requestedUrls()).toEqual([`${BASE}/role/data-wrangler`, `${BASE}/jobs`]);
      expect(ids(res.jobs)).toEqual(['x']);
    });

    it('a role page that resolves to a different role is not trusted', async () => {
      routeHttp({
        [`${BASE}/role/rust-backend`]: page({ role: 'backend-engineer', startups: [{ id: '1', listings: ['z'] }] }),
        [`${BASE}/jobs`]: page({
          roleKeyword: null,
          startups: [{ id: '2', listings: ['r', 'b'] }],
          listings: { r: { title: 'Rust Backend Engineer' }, b: { title: 'Backend Engineer' } },
        }),
      });

      const res = await service.scrape(input({ searchTerm: 'rust backend' }));

      expect(requestedUrls()).toEqual([`${BASE}/role/rust-backend`, `${BASE}/jobs`]);
      expect(ids(res.jobs)).toEqual(['r']);
    });

    it('every route missing → empty with a detail', async () => {
      routeHttp({});
      const res = await service.scrape(input({ searchTerm: 'software engineer', location: 'Atlantis' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toEqual({ reason: 'empty', detail: 'no landing page for role/location' });
      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('isRemote selects /role/r/ and keeps remote-eligible listings only on the feed fallback', async () => {
      routeHttp({
        [`${BASE}/jobs`]: page({
          roleKeyword: null,
          startups: [{ id: '1', listings: ['rem', 'onsite'] }],
          listings: { rem: { remote: true }, onsite: { remote: false } },
        }),
      });

      const res = await service.scrape(input({ searchTerm: 'software engineer', isRemote: true }));

      expect(requestedUrls()).toEqual([`${BASE}/role/r/software-engineer`, `${BASE}/jobs`]);
      expect(ids(res.jobs)).toEqual(['rem']);
    });
  });

  describe('diagnostics', () => {
    it('a payload without apolloState is structure drift (unknown)', async () => {
      routeHttp({ [`${BASE}/role/software-engineer`]: { status: 200, data: htmlPage({ page: '/seoLanding/roleSearch', props: { pageProps: {} } }) } });
      const res = await service.scrape(input({ searchTerm: 'software engineer' }));
      expect(res.diagnostics).toEqual({ reason: 'unknown', detail: 'payload shape changed: no apolloState.data' });
    });

    it('listings fetched but none matching the filters → empty with counts', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({
          startups: [{ id: '1', listings: ['a', 'b'] }],
          listings: { a: { jobType: 'part-time' }, b: { jobType: 'contract' } },
        }),
      });
      const res = await service.scrape(input({ searchTerm: 'software engineer', jobType: JobType.FULL_TIME }));
      expect(res.diagnostics).toEqual({ reason: 'empty', detail: '2 listings fetched, 0 matched filters' });
    });

    it('a page-1 network error is classified', async () => {
      routeHttp({ [`${BASE}/role/software-engineer`]: new Error('getaddrinfo ENOTFOUND wellfound.com') });
      const res = await service.scrape(input({ searchTerm: 'software engineer' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a 200 page with no payload at all ends as empty after the chain', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: { status: 200, data: '<html><body>maintenance</body></html>' },
        [`${BASE}/jobs`]: { status: 200, data: '<html><body>maintenance</body></html>' },
      });
      const res = await service.scrape(input({ searchTerm: 'software engineer' }));
      expect(res.diagnostics).toEqual({ reason: 'empty', detail: 'no __NEXT_DATA__ payload on the landing pages' });
    });
  });

  describe('input filters', () => {
    it('hoursOld drops older listings (the feed is not date-ordered, so it never stops early)', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({
          startups: [{ id: '1', listings: ['old', 'new', 'undated'] }],
          listings: { old: { liveStartAt: nowSec - 72 * 3600 }, new: { liveStartAt: nowSec - 3600 }, undated: { liveStartAt: null } },
        }),
      });
      const res = await service.scrape(input({ searchTerm: 'software engineer', hoursOld: 24 }));
      expect(ids(res.jobs)).toEqual(['new', 'undated']);
    });

    it('jobType keeps matching listings only', async () => {
      routeHttp({
        [`${BASE}/role/software-engineer`]: page({
          startups: [{ id: '1', listings: ['ft', 'intern'] }],
          listings: { ft: { jobType: 'full-time' }, intern: { jobType: 'internship' } },
        }),
      });
      const res = await service.scrape(input({ searchTerm: 'software engineer', jobType: JobType.INTERNSHIP }));
      expect(ids(res.jobs)).toEqual(['intern']);
    });

    it('offset skips matching listings in site order', async () => {
      routeHttp({ [`${BASE}/role/software-engineer`]: page({ startups: [{ id: '1', listings: ['a', 'b', 'c'] }] }) });
      const res = await service.scrape(input({ searchTerm: 'software engineer', offset: 2 }));
      expect(ids(res.jobs)).toEqual(['c']);
      const past = await service.scrape(input({ searchTerm: 'software engineer', offset: 5 }));
      expect(past.jobs).toEqual([]);
      expect(past.diagnostics?.reason).toBe('empty');
    });
  });

  describe('operator options', () => {
    it('WELLFOUND_ROUTE_MODE=feed reads only /jobs and filters locally', async () => {
      process.env[WELLFOUND_ROUTE_MODE_ENV] = 'feed';
      routeHttp({
        [`${BASE}/jobs`]: page({
          roleKeyword: null,
          startups: [{ id: '1', listings: ['a', 'b'] }],
          listings: { a: { title: 'Rust Engineer' }, b: { title: 'Designer' } },
        }),
      });
      const res = await service.scrape(input({ searchTerm: 'rust' }));
      expect(requestedUrls()).toEqual([`${BASE}/jobs`]);
      expect(ids(res.jobs)).toEqual(['a']);
    });

    it('an unrecognised option value falls back to the default', async () => {
      process.env[WELLFOUND_FETCH_MODE_ENV] = 'turbo';
      routeHttp({ [`${BASE}/jobs`]: page({ startups: [{ id: '1', listings: ['a'] }] }) });
      const res = await service.scrape(input({}));
      expect(ids(res.jobs)).toEqual(['a']);
      expect(mockGetPage).not.toHaveBeenCalled();
    });

    describe('WELLFOUND_FETCH_MODE=browser (the pre-Spec-1708 transport)', () => {
      function fakeBrowserPage(pages: Record<string, { status: number; nd?: unknown; html?: string }>) {
        let current = '';
        const context = { close: jest.fn().mockResolvedValue(undefined) };
        return {
          goto: jest.fn(async (url: string) => {
            current = url;
            return { status: () => pages[url]?.status ?? 404 };
          }),
          evaluate: jest.fn(async () => (pages[current]?.nd ? JSON.stringify(pages[current].nd) : null)),
          content: jest.fn(async () => pages[current]?.html ?? ''),
          close: jest.fn().mockResolvedValue(undefined),
          context: () => context,
          contextClose: context.close,
        };
      }

      beforeEach(() => {
        process.env[WELLFOUND_FETCH_MODE_ENV] = 'browser';
      });

      it('reads every page through one browser page, without stealth, and closes it', async () => {
        const fake = fakeBrowserPage({
          [`${BASE}/role/software-engineer`]: { status: 200, nd: landingPayload({ pageCount: 2, startups: [{ id: '1', listings: ['a'] }] }) },
          [`${BASE}/role/software-engineer?page=2`]: {
            status: 200,
            nd: landingPayload({ page: 2, pageCount: 2, startups: [{ id: '2', listings: ['b'] }] }),
          },
        });
        mockGetPage.mockReset();
        mockGetPage.mockResolvedValue(fake);

        const res = await service.scrape(input({ searchTerm: 'software engineer', proxies: ['http://p1:1', 'http://p2:2'] }));

        expect(ids(res.jobs)).toEqual(['a', 'b']);
        expect(mockGetPage).toHaveBeenCalledTimes(1);
        expect(mockGetPage).toHaveBeenCalledWith({ proxy: 'http://p1:1' });
        expect(fake.goto).toHaveBeenCalledTimes(2);
        expect(mockGet).not.toHaveBeenCalled();
        expect(fake.close).toHaveBeenCalled();
        expect(fake.contextClose).toHaveBeenCalled();
      });

      it('an interstitial in the browser is blocked', async () => {
        const fake = fakeBrowserPage({
          [`${BASE}/role/software-engineer`]: { status: 403, html: readFixture('interstitial.synthetic.html') },
        });
        mockGetPage.mockReset();
        mockGetPage.mockResolvedValue(fake);
        const res = await service.scrape(input({ searchTerm: 'software engineer' }));
        expect(res.diagnostics?.reason).toBe('blocked');
        expect(fake.close).toHaveBeenCalled();
      });

      it('a missing browser is browser_unavailable', async () => {
        mockGetPage.mockReset();
        mockGetPage.mockRejectedValue(new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium"));
        const res = await service.scrape(input({ searchTerm: 'software engineer' }));
        expect(res.diagnostics?.reason).toBe('browser_unavailable');
      });
    });
  });

  it('keeps no per-run state on the singleton: two concurrent scrapes do not mix', async () => {
    routeHttp({
      [`${BASE}/role/software-engineer`]: page({ pageCount: 2, startups: [{ id: '1', listings: ['se1'] }] }),
      [`${BASE}/role/software-engineer?page=2`]: page({ page: 2, pageCount: 2, startups: [{ id: '2', listings: ['se2'] }] }),
      [`${BASE}/role/designer`]: page({ role: 'designer', pageCount: 2, startups: [{ id: '3', listings: ['d1'] }] }),
      [`${BASE}/role/designer?page=2`]: page({ role: 'designer', page: 2, pageCount: 2, startups: [{ id: '4', listings: ['d2'] }] }),
    });

    const [a, b] = await Promise.all([
      service.scrape(input({ searchTerm: 'software engineer', resultsWanted: 10 })),
      service.scrape(input({ searchTerm: 'designer', resultsWanted: 10 })),
    ]);

    expect(ids(a.jobs)).toEqual(['se1', 'se2']);
    expect(ids(b.jobs)).toEqual(['d1', 'd2']);
    expect(mockCreateHttpClient).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy closes the browser pool', async () => {
    await service.onModuleDestroy();
    expect(mockBrowserClose).toHaveBeenCalled();
  });
});
