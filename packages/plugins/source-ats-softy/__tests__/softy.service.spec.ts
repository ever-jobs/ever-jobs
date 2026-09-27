import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

const mockCreateHttpClient = jest.fn();
const mockGetScrapeContext = jest.fn();
const mockGetEffectiveCrawlPolicy = jest.fn();
const mockResolveCrawlPolicy = jest.fn();
const mockRunWithScrapeContext = jest.fn();

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args),
    getScrapeContext: (...args: unknown[]) => mockGetScrapeContext(...args),
    getEffectiveCrawlPolicy: (...args: unknown[]) => mockGetEffectiveCrawlPolicy(...args),
    resolveCrawlPolicy: (...args: unknown[]) => mockResolveCrawlPolicy(...args),
    runWithScrapeContext: (...args: unknown[]) => mockRunWithScrapeContext(...args),
  };
});

import { HostCoolingDownError, resetCrawlPolicyEnvCache, RobotsDisallowedError } from '@ever-jobs/common';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { SoftyService } from '../src/softy.service';
import {
  SOFTY_BROWSER_USER_AGENT,
  SOFTY_CRAWL_POLICY,
  SOFTY_DESCRIPTION_MAX_CHARS,
  SOFTY_ENV,
  SOFTY_HEADERS,
} from '../src/softy.constants';

/**
 * `SoftyService` against a fake HTTP client (Specs 1691, 1715): discovery modes,
 * pagination, legacy markup, caching and the failure tables of Spec 1715 §7.3 /
 * §7.4. The crawl-policy resolver is mocked here (it honours the caller's
 * `crawl.discovery`, like EVER_JOBS_CRAWL_CALLER_OVERRIDES=any); the real resolver —
 * and the Softy lock on `crawl.discovery` — is exercised by `softy.policy.spec.ts`,
 * the real `HttpClient` and limiter by `softy.integration.spec.ts`. The caller-lock
 * MODE the plugin reads for its own decisions (round 2, A1) comes from the real
 * `resolveCallerOverrides` (the Softy manifest + the builtin `*.softy.pro` host
 * policy → `stricter` on a clean env). No network.
 *
 * Every test of a behaviour Spec 1715 changed has a twin that asserts the pre-1715
 * behaviour under the switch that restores it (`SOFTY_LEGACY`, `SOFTY_SITEMAP_FALLBACK`,
 * …), so the old behaviour stays one switch away and each new assertion is shown to
 * depend on the default.
 */

// ── fixtures & fake Softy server ─────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const BASE = 'https://acme.softy.pro';
const SITEMAP = `${BASE}/sitemap.xml`;
const PAGE = (n: number) => `${BASE}/offers?page=${n}`;
const OFFER = (id: string | number) => `${BASE}/offers/${id}`;
/** Where the legacy index is read since Spec 1715 (FR-14). */
const LEGACY_INDEX = `${BASE}/offers`;
/** Where it was read before (`SOFTY_LEGACY=offres`). */
const LEGACY_OFFRES = `${BASE}/offres`;

const TITLES: Record<string, string> = {
  '1001': 'Développeur Full-Stack - H/F',
  '1002': 'Chef de projet PMO - H/F',
  '1003': 'Alternant(e) Marketing Digital',
  '1004': 'Data Analyst',
  '1005': 'Stagiaire Comptabilité',
};

const detailPage = (id: string, title = TITLES[id] ?? `Offre ${id}`) =>
  fixture('detail.html').replace(/__ID__/g, id).replace(/__TITLE__/g, title);

type Route = string | Error | { status: number; headers?: Record<string, string> };

function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers },
  });
}

function networkError(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * A fake HttpClient serving a route table. Every request waits a tick, so a caller
 * that fanned out would be seen with more than one request in flight.
 */
class FakeSofty {
  readonly routes = new Map<string, Route>();
  readonly calls: string[] = [];
  readonly configs: any[] = [];
  inFlight = 0;
  maxInFlight = 0;
  onRequest?: (url: string) => void;
  readonly setHeaders = jest.fn();
  readonly post = jest.fn();
  readonly get = jest.fn(async (url: string, config?: any) => {
    this.calls.push(url);
    this.configs.push(config);
    this.onRequest?.(url);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const route = this.routes.get(url);
      if (route === undefined) throw httpError(404);
      if (route instanceof Error) throw route;
      if (typeof route === 'object') throw httpError(route.status, route.headers);
      const data = config?.responseType === 'arraybuffer' ? Buffer.from(route, 'utf8') : route;
      return { data, status: 200, headers: {} };
    } finally {
      this.inFlight--;
    }
  });

  set(url: string, route: Route): this {
    this.routes.set(url, route);
    return this;
  }

  /** The acme tenant: sitemap, two listing pages, five detail pages. */
  static acme(): FakeSofty {
    const fake = new FakeSofty()
      .set(SITEMAP, fixture('sitemap.xml'))
      .set(PAGE(1), fixture('listing-page-1.html'))
      .set(PAGE(2), fixture('listing-page-2.html'));
    for (const id of Object.keys(TITLES)) fake.set(OFFER(id), detailPage(id));
    return fake;
  }

  detailCalls(): string[] {
    return this.calls.filter((u) => /\/offers\/\d+$/.test(u) || /\/offre\//.test(u));
  }
}

/** A generated listing page of `ids`, linking pages 1..`lastPage`. */
function generatedPage(ids: number[], page: number, lastPage: number): string {
  const cards = ids
    .map(
      (id) => `<a href="${OFFER(id)}"><div data-slot="card"><h3 data-slot="joboffer-title">Offre ${id}</h3>
        <div data-slot="joboffer-locations"><p>Ville ${id}</p></div>
        <span data-slot="joboffer-published-at"><div>Mise en ligne le 01/09/2026</div></span>
        <span data-slot="badge">CDI</span></div></a>`,
    )
    .join('\n');
  const links = Array.from({ length: lastPage }, (_, i) => `<a data-slot="pagination-link" href="${PAGE(i + 1)}">${i + 1}</a>`).join('');
  const next = page < lastPage ? `<a aria-label="Suivant" href="${PAGE(page + 1)}">Suivant</a>` : '';
  return `<html><body><main>${cards}<nav data-slot="pagination">${links}${next}</nav></main></body></html>`;
}

function generatedSitemap(ids: number[]): string {
  const urls = ids
    .map((id, i) => `<url><loc>${OFFER(id)}</loc><lastmod>2026-09-${String(28 - (i % 27)).padStart(2, '0')} 10:00:00</lastmod></url>`)
    .join('');
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

/** A search input for the acme tenant; `overrides` may carry any field (incl. an invalid `crawl`). */
function input(overrides: Record<string, any> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.SOFTY],
    companySlug: 'acme',
    resultsWanted: 5,
    descriptionFormat: DescriptionFormat.MARKDOWN,
    ...overrides,
  } as Partial<ScraperInputDto>);
}

/**
 * Env the tests read or set. The crawl-policy keys matter because the caller lock
 * (round 2, A1) is resolved by the REAL `resolveCallerOverrides` from the env.
 */
const ENV_KEYS = [
  ...Object.values(SOFTY_ENV),
  'EVER_JOBS_CRAWL_DISCOVERY',
  'EVER_JOBS_CRAWL_POLICIES',
  'EVER_JOBS_CRAWL_POLICY_FILE',
  'EVER_JOBS_CRAWL_CALLER_OVERRIDES',
  'EVER_JOBS_CRAWL_PRESET',
  'EVER_JOBS_CRAWL_PLUGIN_MANIFESTS',
  'EVER_JOBS_CRAWL_BUILTIN_HOSTS',
  'EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE',
];
const MODES = ['auto', 'sitemap', 'listing'];

/** The mocked resolver: the caller's `crawl.discovery` wins (as under callerOverrides `any`), else `auto`. */
function honourCaller(req: { caller?: { discovery?: unknown } } | undefined): { discovery: string } {
  const value = req?.caller?.discovery;
  return { discovery: typeof value === 'string' && MODES.includes(value) ? value : 'auto' };
}

describe('SoftyService (Specs 1691, 1715)', () => {
  let fake: FakeSofty;
  let service: SoftyService;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetCrawlPolicyEnvCache();
    fake = FakeSofty.acme();
    service = new SoftyService();
    mockCreateHttpClient.mockReset().mockImplementation(() => fake);
    mockGetScrapeContext.mockReset().mockReturnValue(undefined);
    mockGetEffectiveCrawlPolicy.mockReset().mockReturnValue({ discovery: 'auto' });
    mockResolveCrawlPolicy.mockReset().mockImplementation(honourCaller);
    mockRunWithScrapeContext.mockReset().mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetCrawlPolicyEnvCache();
    jest.restoreAllMocks();
  });

  /** Swap in another fake client (a different tenant / route table). */
  function useClient(client: FakeSofty): FakeSofty {
    mockCreateHttpClient.mockImplementation(() => client);
    return client;
  }

  // ── manifest & identity ─────────────────────────────────────────────────────

  describe('manifest and identity', () => {
    it('declares the Softy crawl policy in @SourcePlugin (Spec 1715 FR-1)', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, SoftyService);
      expect(meta).toMatchObject({ site: Site.SOFTY, name: 'Softy', category: 'ats', isAts: true });
      expect(meta.crawl).toEqual({
        rateLimitScope: 'domain',
        maxConcurrentPerHost: 1,
        minIntervalMs: 1000,
        minGapMs: 500,
        callerOverrides: 'stricter',
        proxyRotation: 'per-host',
        retries: 1,
        retryStatuses: [429, 503],
        throttleRetryDelayMs: 10000,
        serverErrorCooldownMs: 30000,
        respectRetryAfter: true,
        retryAfterOverMax: 'give-up',
        userAgentMode: 'identify',
      });
      expect(meta.crawl).toBe(SOFTY_CRAWL_POLICY);
    });

    it('no longer puts the browser UA in SOFTY_HEADERS; it only declares it', async () => {
      expect(Object.keys(SOFTY_HEADERS).map((k) => k.toLowerCase())).toEqual(['accept', 'accept-language']);
      expect(SOFTY_BROWSER_USER_AGENT).toContain('Chrome/129');
      await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(fake.setHeaders).toHaveBeenCalledTimes(1);
      expect(fake.setHeaders).toHaveBeenCalledWith({ ...SOFTY_HEADERS, 'User-Agent': SOFTY_BROWSER_USER_AGENT });
    });

    it('builds the client from the caller proxies / CA / timeout, with a 1 s interval floor (FR-2)', async () => {
      await service.scrape(input({ proxies: ['p1:8080'], caCert: 'ca', requestTimeout: 12, descriptionDepth: 'board' }));
      expect(mockCreateHttpClient).toHaveBeenCalledWith({
        proxies: ['p1:8080'],
        caCert: 'ca',
        timeout: 12,
        minIntervalFloorMs: 1000,
      });
    });

    it('SOFTY_LEGACY=no-interval-floor builds the client without the floor (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'no-interval-floor';
      await service.scrape(input({ descriptionDepth: 'board' }));
      expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({ minIntervalFloorMs: 0 });
    });
  });

  // ── sitemap discovery ───────────────────────────────────────────────────────

  describe('sitemap discovery', () => {
    it('reads the sitemap, newest lastmod first, then one detail page per wanted offer', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001), OFFER(1002)]);
      expect(res.diagnostics).toBeUndefined();
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-1005', 'softy-1001', 'softy-1002']);

      const job = res.jobs[0];
      expect(job).toMatchObject({
        title: 'Stagiaire Comptabilité',
        companyName: 'Acme',
        jobUrl: OFFER(1005),
        applyUrl: OFFER(1005),
        atsId: '1005',
        atsType: 'softy',
        site: Site.SOFTY,
        employmentType: 'CDI',
        datePosted: '2026-09-22',
        isRemote: false,
        department: null,
      });
      expect(job.location).toMatchObject({ city: 'Toulouse' });
      // Spec 5126: a one-line posting carries exactly [location]
      expect(job.locations).toEqual([job.location]);
      expect(job.emails).toEqual(['jobs@acme.example']);
      expect(job.description).toContain("L'entreprise");
      expect(job.description).toContain('Concevoir des API');
      expect(job.description).not.toMatch(/not the description|alert|Voir plus/);
    });

    it('asks for the sitemap as arraybuffer and for pages as text', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.configs[0]).toMatchObject({ responseType: 'arraybuffer' });
      expect(fake.configs[1]).toMatchObject({ responseType: 'text' });
    });

    it('applies offset to the sorted entries', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, offset: 1, resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002']);
      expect(fake.detailCalls()).toEqual([OFFER(1001), OFFER(1002)]);
    });

    it('skips an offer whose page has gone and fills from the next entry', async () => {
      fake.set(OFFER(1005), { status: 404 });
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('uses the lastmod date as datePosted unless SOFTY_LASTMOD_AS_DATE_POSTED=false', async () => {
      process.env.SOFTY_LASTMOD_AS_DATE_POSTED = 'false';
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(res.jobs[0].datePosted).toBeNull();
    });

    it('follows a sitemap index', async () => {
      fake.set(SITEMAP, fixture('sitemap-index.xml')).set(`${BASE}/sitemap-offers.xml`, fixture('sitemap.xml'));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005']);
      expect(fake.calls.slice(0, 2)).toEqual([SITEMAP, `${BASE}/sitemap-offers.xml`]);
    });

    it('ignores sitemap entries that are not offers of this tenant', async () => {
      fake.set(
        SITEMAP,
        `<urlset><url><loc>https://other.softy.pro/offers/9</loc></url><url><loc>${BASE}/offers/1001/apply</loc></url>
         <url><loc>${OFFER(1001)}</loc></url></urlset>`,
      );
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' } }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001']);
      expect(fake.detailCalls()).toEqual([OFFER(1001)]);
    });

    it('keeps one entry per offer id, the newest lastmod (FR-10)', async () => {
      fake.set(SITEMAP, fixture('sitemap-duplicate-ids.xml'));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001), OFFER(1002)]);
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-1001', 'softy-1002']);
      expect(res.jobs[0].datePosted).toBe('2026-09-25');
    });

    it('applies offset after the dedupe', async () => {
      fake.set(SITEMAP, fixture('sitemap-duplicate-ids.xml'));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, offset: 1, resultsWanted: 3 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1002']);
    });

    it('SOFTY_LEGACY=duplicate-ids: every entry, the same offer fetched twice (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'duplicate-ids';
      fake.set(SITEMAP, fixture('sitemap-duplicate-ids.xml'));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001), OFFER(1001), OFFER(1002)]);
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-1001', 'softy-1001', 'softy-1002']);
    });

    it('detail-25 caps detail fetches (and so results) at 25', async () => {
      const ids = Array.from({ length: 30 }, (_, i) => 2000 + i);
      fake.set(SITEMAP, generatedSitemap(ids));
      ids.forEach((id) => fake.set(OFFER(id), detailPage(String(id))));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 30, descriptionDepth: 'detail-25' }));
      expect(fake.detailCalls()).toHaveLength(25);
      expect(res.jobs).toHaveLength(25);
      // …and says so: the board is not complete, the budget cut it short.
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('5 sitemap offer(s) not returned');
    });

    it('SOFTY_MAX_DETAIL_FETCHES bounds detail-all', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '2';
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 5, descriptionDepth: 'detail-all' }));
      expect(fake.detailCalls()).toHaveLength(2);
      expect(res.jobs).toHaveLength(2);
      expect(res.diagnostics?.reason).toBe('partial');
    });

    it('no budget diagnostic when the budget covered everything wanted', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 5, descriptionDepth: 'detail-25' }));
      expect(res.jobs).toHaveLength(5);
      expect(res.diagnostics).toBeUndefined();
    });

    it('explicit sitemap mode does not fall back: a 404 sitemap → empty + bad_input', async () => {
      fake.set(SITEMAP, { status: 404 });
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' } }));
      expect(res.jobs).toEqual([]);
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('bad_input');
    });

    it('explicit sitemap mode: a 5xx sitemap → empty + fetch_error', async () => {
      fake.set(SITEMAP, { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' } }));
      expect(res.jobs).toEqual([]);
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('explicit sitemap mode never falls back, even under SOFTY_SITEMAP_FALLBACK=any-error', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      fake.set(SITEMAP, { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' } }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });
  });

  // ── sitemap stage table (Spec 1715 §7.3) ───────────────────────────────────

  describe('sitemap stage in auto (SOFTY_SITEMAP_FALLBACK, Spec 1715 §7.3)', () => {
    const EMPTY_URLSET = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
    const NO_OFFERS = `<urlset><url><loc>${BASE}</loc></url><url><loc>${PAGE(1)}</loc></url></urlset>`;
    const SOFT_404 = '<!doctype html><html><body>Page introuvable</body></html>';
    const LISTING_SEQUENCE = [SITEMAP, PAGE(1), OFFER(1001), OFFER(1002)];

    it('uses the sitemap when it has offers', async () => {
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001)]);
      expect(res.jobs).toHaveLength(2);
    });

    it.each([
      ['an empty urlset', EMPTY_URLSET],
      ['a sitemap without offers', NO_OFFERS],
      ['a 2xx that is not a sitemap (soft-404 HTML)', SOFT_404],
    ])('falls back to the listing on %s (every mode)', async (_label, body) => {
      for (const mode of ['empty', 'missing', 'any-error']) {
        process.env.SOFTY_SITEMAP_FALLBACK = mode;
        const tenant = useClient(FakeSofty.acme().set(SITEMAP, body));
        service.clearCaches();
        const res = await service.scrape(input({ resultsWanted: 2 }));
        expect(tenant.calls).toEqual(LISTING_SEQUENCE);
        expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002']);
        expect(res.diagnostics).toBeUndefined();
      }
    });

    it.each([
      ['a bot-wall page', fixture('challenge.html'), 'blocked'],
      ['401', { status: 401 } as Route, 'blocked'],
      ['403', { status: 403 } as Route, 'blocked'],
      ['407', { status: 407 } as Route, 'blocked'],
      ['429 (after HttpClient’s retry)', { status: 429 } as Route, 'rate_limited'],
      ['503', { status: 503 } as Route, 'rate_limited'],
      ['500', { status: 500 } as Route, 'fetch_error'],
      ['502', { status: 502 } as Route, 'fetch_error'],
      ['504', { status: 504 } as Route, 'fetch_error'],
      ['another 4xx (400)', { status: 400 } as Route, 'bad_input'],
      ['a timeout', networkError('ECONNABORTED', 'timeout of 60000ms exceeded'), 'timeout'],
      ['a connection reset', networkError('ECONNRESET', 'socket hang up'), 'fetch_error'],
      ['a crawl-policy cool-down', new HostCoolingDownError('domain:softy.pro', 120000, 429), 'rate_limited'],
    ])('default (empty): %s stops the scrape → %s, no list page', async (_label, route, reason) => {
      fake.set(SITEMAP, route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it.each([404, 410])('default (empty): a %s stops with bad_input naming SOFTY_SITEMAP_FALLBACK=missing', async (status) => {
      fake.set(SITEMAP, { status });
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toContain('SOFTY_SITEMAP_FALLBACK=missing');
    });

    it('missing: a 404 falls back to the listing (the Spec 1691 wording)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'missing';
      fake.set(SITEMAP, { status: 404 });
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual(LISTING_SEQUENCE);
      expect(res.diagnostics).toBeUndefined();
    });

    it.each([
      ['a bot-wall page', fixture('challenge.html'), 'blocked'],
      ['403', { status: 403 } as Route, 'blocked'],
      ['503', { status: 503 } as Route, 'rate_limited'],
      ['500', { status: 500 } as Route, 'fetch_error'],
    ])('missing: %s still stops → %s', async (_label, route, reason) => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'missing';
      fake.set(SITEMAP, route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it('a robots.txt refusal stops as blocked (empty); missing and any-error fall back', async () => {
      fake.set(SITEMAP, new RobotsDisallowedError(SITEMAP));
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('blocked');

      for (const mode of ['missing', 'any-error']) {
        process.env.SOFTY_SITEMAP_FALLBACK = mode;
        const tenant = useClient(FakeSofty.acme().set(SITEMAP, new RobotsDisallowedError(SITEMAP)));
        service.clearCaches();
        await service.scrape(input({ resultsWanted: 2 }));
        expect(tenant.calls).toEqual(LISTING_SEQUENCE);
      }
    });

    // The shipped (pre-1715) sitemap stage, kept whole under `any-error` (the red
    // control of every "stops" row above: the listing is requested instead).
    it.each([
      ['a 404', { status: 404 } as Route],
      ['an empty urlset', EMPTY_URLSET],
      ['a sitemap without offers', NO_OFFERS],
      ['garbage', SOFT_404],
      ['a 5xx', { status: 503 } as Route],
      ['a 500', { status: 500 } as Route],
      ['a network error', networkError('ECONNRESET', 'socket hang up')],
      ['a 403', { status: 403 } as Route],
      ['a bot-wall page', fixture('challenge.html')],
      ['a host that does not resolve', networkError('ENOTFOUND', 'getaddrinfo ENOTFOUND acme.softy.pro')],
    ])('SOFTY_SITEMAP_FALLBACK=any-error falls back to the listing on %s (pre-1715)', async (_label, route) => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      fake.set(SITEMAP, route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual(LISTING_SEQUENCE);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('SOFTY_SITEMAP_FALLBACK=any-error still stops on a 429 / crawl-policy refusal (as shipped)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      fake.set(SITEMAP, { status: 429 });
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('a nested sitemap answering 429 stops the scrape: no further document, no detail page (FR-16)', async () => {
      const INDEX = `<sitemapindex><sitemap><loc>${BASE}/s1.xml</loc></sitemap><sitemap><loc>${BASE}/s2.xml</loc></sitemap></sitemapindex>`;
      fake.set(SITEMAP, INDEX).set(`${BASE}/s1.xml`, { status: 429 }).set(`${BASE}/s2.xml`, fixture('sitemap.xml'));
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP, `${BASE}/s1.xml`]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('a nested sitemap answering 403 stops the scrape as blocked', async () => {
      const INDEX = `<sitemapindex><sitemap><loc>${BASE}/s1.xml</loc></sitemap><sitemap><loc>${BASE}/s2.xml</loc></sitemap></sitemapindex>`;
      fake.set(SITEMAP, INDEX).set(`${BASE}/s1.xml`, { status: 403 }).set(`${BASE}/s2.xml`, fixture('sitemap.xml'));
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP, `${BASE}/s1.xml`]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('a nested sitemap that is gone (404) is skipped and the walk goes on', async () => {
      const INDEX = `<sitemapindex><sitemap><loc>${BASE}/s1.xml</loc></sitemap><sitemap><loc>${BASE}/s2.xml</loc></sitemap></sitemapindex>`;
      fake.set(SITEMAP, INDEX).set(`${BASE}/s2.xml`, fixture('sitemap.xml'));
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls).toEqual([SITEMAP, `${BASE}/s1.xml`, `${BASE}/s2.xml`, OFFER(1005)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005']);
    });

    // ── nested sitemaps, round 2 (A5: a struggling server stops; F4: the pre-1715 skip is a switch) ──

    const S1 = `${BASE}/s1.xml`;
    const S2 = `${BASE}/s2.xml`;
    const NESTED_INDEX = `<sitemapindex><sitemap><loc>${S1}</loc></sitemap><sitemap><loc>${S2}</loc></sitemap></sitemapindex>`;
    const nestedTenant = (first: Route): FakeSofty =>
      useClient(FakeSofty.acme().set(SITEMAP, NESTED_INDEX).set(S1, first).set(S2, fixture('sitemap.xml')));

    it.each([
      ['500', 'fetch_error', { status: 500 } as Route],
      ['502', 'fetch_error', { status: 502 } as Route],
      ['504', 'fetch_error', { status: 504 } as Route],
      ['a timeout', 'timeout', networkError('ECONNABORTED', 'timeout of 60000ms exceeded')],
      ['a connection reset', 'fetch_error', networkError('ECONNRESET', 'socket hang up')],
    ])('a nested sitemap answering %s stops the scrape → %s: no further document, no detail page (A5)', async (_label, reason, route) => {
      const tenant = nestedTenant(route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(tenant.calls).toEqual([SITEMAP, S1]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it('a nested sitemap that is gone (410) is still skipped: not a struggling server (A5 leaves it alone)', async () => {
      const tenant = nestedTenant({ status: 410 });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(tenant.calls).toEqual([SITEMAP, S1, S2, OFFER(1005)]);
      expect(res.diagnostics).toBeUndefined();
    });

    it.each([
      ['502', { status: 502 } as Route],
      ['a timeout', networkError('ECONNABORTED', 'timeout of 60000ms exceeded')],
      ['429', { status: 429 } as Route],
      ['503', { status: 503 } as Route],
      ['403', { status: 403 } as Route],
      ['a crawl-policy cool-down', new HostCoolingDownError('domain:softy.pro', 30000, 502)],
    ])('SOFTY_LEGACY=nested-skip: a nested %s is skipped and the walk goes on (pre-1715; red control of A5 / FR-16)', async (_label, route) => {
      process.env.SOFTY_LEGACY = 'nested-skip';
      const tenant = nestedTenant(route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(tenant.calls).toEqual([SITEMAP, S1, S2, OFFER(1005), OFFER(1001)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005', '1001']);
      expect(res.diagnostics).toBeUndefined();
    });

    it.each([
      ['502', { status: 502 } as Route],
      ['429', { status: 429 } as Route],
      ['403', { status: 403 } as Route],
    ])('SOFTY_SITEMAP_FALLBACK=any-error: a nested %s is skipped as before 1715 (F4)', async (_label, route) => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      const tenant = nestedTenant(route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(tenant.calls).toEqual([SITEMAP, S1, S2, OFFER(1005), OFFER(1001)]);
      expect(res.diagnostics).toBeUndefined();
    });
  });

  // ── unknown tenants (Spec 1715 FR-5) ────────────────────────────────────────

  describe('unknown tenants (ENOTFOUND on the first request)', () => {
    const NOBODY = 'https://nobody.softy.pro';
    const dns = () => networkError('ENOTFOUND', 'getaddrinfo ENOTFOUND nobody.softy.pro');

    function unresolvable(): FakeSofty {
      const client = new FakeSofty();
      client.get.mockImplementation(async (url: string) => {
        client.calls.push(url);
        throw dns();
      });
      return useClient(client);
    }

    it('stops at once with bad_input, then sends nothing for an hour', async () => {
      let now = 5_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const client = unresolvable();

      const first = await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toEqual([`${NOBODY}/sitemap.xml`]);
      expect(first.jobs).toEqual([]);
      expect(first.diagnostics?.reason).toBe('bad_input');
      expect(first.diagnostics?.detail).toContain('unknown Softy tenant "nobody"');
      expect(first.diagnostics?.detail).toContain('nobody.softy.pro does not resolve');
      expect(first.diagnostics?.detail).toContain('1 h');

      client.calls.length = 0;
      now += 3_599_999;
      const second = await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toEqual([]);
      expect(second.diagnostics).toEqual(first.diagnostics);

      now += 1;
      await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toEqual([`${NOBODY}/sitemap.xml`]);
    });

    it('SOFTY_UNKNOWN_TENANT_TTL_MS=0: still stops, but asks DNS again next time (no negative cache)', async () => {
      process.env.SOFTY_UNKNOWN_TENANT_TTL_MS = '0';
      const client = unresolvable();
      const first = await service.scrape(input({ companySlug: 'nobody' }));
      expect(first.diagnostics?.reason).toBe('bad_input');
      expect(first.diagnostics?.detail).toContain('SOFTY_UNKNOWN_TENANT_TTL_MS=0');
      await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toEqual([`${NOBODY}/sitemap.xml`, `${NOBODY}/sitemap.xml`]);
    });

    it('is detected on the listing path too (board depth)', async () => {
      const client = unresolvable();
      const res = await service.scrape(input({ companySlug: 'nobody', descriptionDepth: 'board' }));
      expect(client.calls).toEqual([`${NOBODY}/offers?page=1`]);
      expect(res.diagnostics?.reason).toBe('bad_input');
    });

    it('recognises ENOTFOUND in the error cause', async () => {
      const client = new FakeSofty();
      client.get.mockImplementation(async (url: string) => {
        client.calls.push(url);
        throw Object.assign(new Error('request failed'), { cause: dns() });
      });
      useClient(client);
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toHaveLength(1);
      expect(res.diagnostics?.detail).toContain('unknown Softy tenant');
    });

    it('a transient resolver failure (EAI_AGAIN) is not an unknown tenant', async () => {
      const client = new FakeSofty();
      client.get.mockImplementation(async (url: string) => {
        client.calls.push(url);
        throw networkError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN nobody.softy.pro');
      });
      useClient(client);
      await service.scrape(input({ companySlug: 'nobody' }));
      const again = await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toHaveLength(2);
      expect(again.diagnostics?.reason).toBe('fetch_error');
    });

    it('SOFTY_SITEMAP_FALLBACK=any-error: empty with no diagnostic, every request made (pre-1715)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      process.env.SOFTY_LEGACY = 'offres';
      const client = unresolvable();
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(client.calls).toEqual([`${NOBODY}/sitemap.xml`, `${NOBODY}/offers?page=1`, `${NOBODY}/offres`]);
      await service.scrape(input({ companySlug: 'nobody' }));
      expect(client.calls).toHaveLength(6);
    });
  });

  // ── listing discovery ───────────────────────────────────────────────────────

  describe('listing discovery', () => {
    it('reads /offers?page=1..N, then the detail pages in card order', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2), OFFER(1001), OFFER(1002), OFFER(1003), OFFER(1004), OFFER(1005)]);
      expect(res.diagnostics).toBeUndefined();
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003', '1004', '1005']);

      const [dev, pmo, alt, data, stage] = res.jobs;
      expect(dev).toMatchObject({
        id: 'softy-1001',
        title: 'Développeur Full-Stack - H/F',
        jobUrl: OFFER(1001),
        datePosted: '2026-09-20',
        employmentType: 'CDI',
        isRemote: false,
      });
      expect(dev.location).toMatchObject({ city: 'Toulouse' });
      expect(dev.locations).toEqual([dev.location]);
      expect(dev.description).toContain('Concevoir des API');
      expect(pmo).toMatchObject({ title: 'Chef de projet & PMO - H/F', employmentType: 'CDD - 6 Mois', datePosted: '2026-09-18' });
      expect(alt).toMatchObject({ employmentType: 'Apprentissage - 24 Mois' });
      expect(data).toMatchObject({ isRemote: true, datePosted: '2026-09-10' });
      expect(stage).toMatchObject({ jobUrl: OFFER(1005), employmentType: 'Stage - 6 Mois', datePosted: '2026-09-22' });
      expect(stage.location).toMatchObject({ city: 'Nantes' });
      expect(stage.locations).toEqual([stage.location]);
    });

    it('stops paginating once resultsWanted cards are collected', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1), OFFER(1001), OFFER(1002)]);
      expect(res.jobs).toHaveLength(2);
    });

    it('stops at the last page the pagination links to', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 50, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs).toHaveLength(5);
    });

    it('stops at a page with no new cards', async () => {
      fake.set(PAGE(2), fixture('listing-page-1.html').replace('offers?page=2">2</a>', 'offers?page=3">3</a>'));
      fake.set(PAGE(3), fixture('listing-page-2.html'));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 50, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs).toHaveLength(3);
    });

    it('keeps paginating without pagination links until a page adds nothing', async () => {
      const strip = (html: string) => html.replace(/<nav[\s\S]*?<\/nav>/, '');
      fake.set(PAGE(1), strip(fixture('listing-page-1.html'))).set(PAGE(2), strip(fixture('listing-page-2.html')));
      fake.set(PAGE(3), fixture('listing-empty.html'));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 50, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2), PAGE(3)]);
      expect(res.jobs).toHaveLength(5);
    });

    it('SOFTY_MAX_LIST_PAGES bounds the pages read', async () => {
      process.env.SOFTY_MAX_LIST_PAGES = '1';
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 50, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toHaveLength(3);
    });

    it('applies offset across pages and fetches details only for the returned slice', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, offset: 2, resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1003', '1004']);
      expect(fake.calls).toEqual([PAGE(1), PAGE(2), OFFER(1003), OFFER(1004)]);
    });

    it('board depth fetches no detail pages (description falls back to the location line)', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(fake.detailCalls()).toEqual([]);
      expect(res.jobs).toHaveLength(5);
      expect(res.jobs[0].description).toBe('Toulouse');
    });

    it('detail-25 fetches the first 25 detail pages and keeps the rest board-only', async () => {
      const page1 = Array.from({ length: 21 }, (_, i) => 3000 + i);
      const page2 = Array.from({ length: 21 }, (_, i) => 3021 + i);
      fake.set(PAGE(1), generatedPage(page1, 1, 2)).set(PAGE(2), generatedPage(page2, 2, 2));
      [...page1, ...page2].forEach((id) => fake.set(OFFER(id), detailPage(String(id))));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 30, descriptionDepth: 'detail-25' }));
      expect(fake.detailCalls()).toHaveLength(25);
      expect(res.jobs).toHaveLength(30);
      expect(res.jobs[24].description).toContain('Concevoir des API');
      expect(res.jobs[25].description).toBe('Ville 3025');
    });

    it('SOFTY_MAX_LIST_PAGES=0 with explicit listing: nothing requested, bad_input (FR-11)', async () => {
      process.env.SOFTY_MAX_LIST_PAGES = '0';
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(fake.calls).toEqual([]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toContain('SOFTY_MAX_LIST_PAGES=0');
    });
  });

  // ── locations ───────────────────────────────────────────────────────────────

  describe('locations (Spec 5125 shared parser, Spec 5126 locations[])', () => {
    const card = (id: number, lines: string[]) => `<a href="${OFFER(id)}"><div data-slot="card"><h3 data-slot="joboffer-title">Offre ${id}</h3>
        <div data-slot="joboffer-locations">${lines.map((line) => `<p>${line}</p>`).join('')}</div>
        <span data-slot="badge">CDI</span></div></a>`;

    async function scrapeCards(...cards: string[]) {
      fake.set(PAGE(1), `<html><body><main>${cards.join('\n')}</main></body></html>`);
      const res = await service.scrape(
        input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board', resultsWanted: cards.length }),
      );
      return res.jobs;
    }

    it('keeps location as the primary line and emits locations: [location] (Spec 5126 singleton)', async () => {
      const [job] = await scrapeCards(card(2001, ['Toulouse', 'Paris, France', 'Télétravail']));
      expect(job.location).toEqual(expect.objectContaining({ city: 'Toulouse', state: null, country: null }));
      expect(job.locations).toEqual([job.location]);
      // A remote marker on any line still flags the role remote.
      expect(job.isRemote).toBe(true);
    });

    it('never emits locations[] without a location (remote marker as the primary line)', async () => {
      const [job] = await scrapeCards(card(2005, ['Télétravail', 'Paris']));
      expect(job.location).toBeNull();
      expect(job.locations).toBeUndefined();
      expect(job.isRemote).toBe(true);
    });

    it('splits a line through the shared parseLocationText (not a comma split)', async () => {
      const [job] = await scrapeCards(card(2002, ['Nantes (44)']));
      expect(job.location).toMatchObject({ city: 'Nantes' });
      expect(job.locations).toEqual([job.location]);
    });

    it('emits one entry for a repeated line, and a remote-only posting emits neither location nor locations', async () => {
      const [twice, remote] = await scrapeCards(card(2003, ['Lyon', 'Lyon (69)']), card(2004, ['Télétravail']));
      expect(twice.locations).toEqual([expect.objectContaining({ city: 'Lyon' })]);
      expect(remote.location).toBeNull();
      expect(remote.locations).toBeUndefined();
      expect(remote.isRemote).toBe(true);
    });
  });

  // ── auto: selection ─────────────────────────────────────────────────────────

  describe('auto discovery: which path', () => {
    it("uses the listing straight away for descriptionDepth 'board'", async () => {
      const res = await service.scrape(input({ descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs).toHaveLength(5);
    });

    it("board depth reads the listing when a CALLER asked for 'sitemap' (Spec 1691, D5)", async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, descriptionDepth: 'board', resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toHaveLength(2);
    });

    it("an OPERATOR's 'sitemap' beats board depth: the sitemap only, with a partial note (FR-11)", async () => {
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'sitemap', provenance: { discovery: 'env-global' } });
      const res = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain("descriptionDepth 'board'");
    });

    it("an operator 'sitemap' with board depth returns the cached offers", async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 2 }));
      fake.calls.length = 0;
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'sitemap', provenance: { discovery: 'operator-site' } });
      const res = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 3 }));
      expect(fake.calls).toEqual([]); // sitemap and both details from the caches
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005', '1001']);
      expect(res.diagnostics?.reason).toBe('partial');
    });

    it('SOFTY_LEGACY=board-over-sitemap: board beats an operator sitemap (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'board-over-sitemap';
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'sitemap', provenance: { discovery: 'env-global' } });
      const res = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('uses the listing when no detail page may be fetched (SOFTY_MAX_DETAIL_FETCHES=0)', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '0';
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toHaveLength(2);
    });

    /** A 65-offer tenant with a sitemap, 4 list pages and every detail page. */
    function bigTenant(): number[] {
      const ids = Array.from({ length: 65 }, (_, i) => 4000 + i);
      const pages = [ids.slice(0, 21), ids.slice(21, 42), ids.slice(42, 63), ids.slice(63)];
      fake.set(SITEMAP, generatedSitemap(ids));
      pages.forEach((pageIds, i) => fake.set(PAGE(i + 1), generatedPage(pageIds, i + 1, pages.length)));
      ids.forEach((id) => fake.set(OFFER(id), detailPage(String(id))));
      return ids;
    }

    const listPageCalls = () => fake.calls.filter((u) => u.includes('?page='));

    it("under the Softy lock a caller's short detail budget stays on the sitemap: 25 posts + partial, no list page (round 2, A1)", async () => {
      // detail-25 with resultsWanted 60 used to read /offers?page=1..3 — a caller could
      // steer the scrape to list pages with ordinary search parameters (audit G22).
      bigTenant();
      const res = await service.scrape(input({ resultsWanted: 60, descriptionDepth: 'detail-25' }));

      expect(fake.calls[0]).toBe(SITEMAP);
      expect(listPageCalls()).toEqual([]);
      expect(fake.detailCalls()).toHaveLength(25);
      expect(res.jobs).toHaveLength(25);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('detail-page budget (25) exhausted');
      expect(res.diagnostics?.detail).toContain("Caller overrides are 'stricter'");
      expect(res.diagnostics?.detail).toContain('SOFTY_LEGACY=caller-listing');
    });

    it('under the lock a resultsWanted above SOFTY_MAX_DETAIL_FETCHES stays on the sitemap too (A1)', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '3';
      const res = await service.scrape(input({ resultsWanted: 5, descriptionDepth: 'detail-all' }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001), OFFER(1002)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005', '1001', '1002']);
      expect(res.diagnostics?.reason).toBe('partial');
    });

    it('SOFTY_LEGACY=caller-listing: the budget trigger reads the listing again (the pre-round-2 selection; red control of A1)', async () => {
      // A 65-offer tenant: the sitemap path would stop at 25 posts; the listing returns 60, 25 of them detailed.
      process.env.SOFTY_LEGACY = 'caller-listing';
      bigTenant();
      const res = await service.scrape(input({ resultsWanted: 60, descriptionDepth: 'detail-25' }));

      expect(fake.calls).not.toContain(SITEMAP);
      expect(listPageCalls()).toEqual([PAGE(1), PAGE(2), PAGE(3)]);
      expect(res.jobs).toHaveLength(60);
      expect(fake.detailCalls()).toHaveLength(25);
      expect(res.diagnostics).toBeUndefined();
    });

    it("an OPERATOR's 'auto' keeps the listing for a short budget (EVER_JOBS_CRAWL_DISCOVERY / sites.softy)", async () => {
      bigTenant();
      for (const layer of ['env-global', 'operator-site', 'operator-host']) {
        mockResolveCrawlPolicy.mockReturnValue({ discovery: 'auto', provenance: { discovery: layer } });
        fake.calls.length = 0;
        service.clearCaches();
        const res = await service.scrape(input({ resultsWanted: 30, descriptionDepth: 'detail-25' }));
        expect(fake.calls).not.toContain(SITEMAP);
        expect(listPageCalls()).toEqual([PAGE(1), PAGE(2)]);
        expect(res.jobs).toHaveLength(30);
      }
    });

    it("with the lock lifted by the operator (sites.softy.callerOverrides 'any') a short budget reads the listing", async () => {
      process.env.EVER_JOBS_CRAWL_POLICIES = JSON.stringify({ sites: { softy: { callerOverrides: 'any' } } });
      resetCrawlPolicyEnvCache();
      bigTenant();
      const res = await service.scrape(input({ resultsWanted: 30, descriptionDepth: 'detail-25' }));
      expect(fake.calls).not.toContain(SITEMAP);
      expect(listPageCalls()).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs).toHaveLength(30);
    });

    it('the lock is resolved from the scrape context (site + plugin layer) and the Softy host', async () => {
      // The builtin *.softy.pro host policy locks even a context without a plugin layer.
      mockGetScrapeContext.mockReturnValue({ site: Site.SOFTY });
      bigTenant();
      const res = await service.scrape(input({ resultsWanted: 30, descriptionDepth: 'detail-25' }));
      expect(fake.calls[0]).toBe(SITEMAP);
      expect(listPageCalls()).toEqual([]);
      expect(res.diagnostics?.detail).toContain('set by builtin-host');
    });

    it('offset does not count against the budget (offset 20 + 10 wanted, budget 25 → sitemap; FR-9)', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '25';
      await service.scrape(input({ offset: 20, resultsWanted: 10, descriptionDepth: 'detail-all' }));
      expect(fake.calls[0]).toBe(SITEMAP);
    });

    it('SOFTY_LEGACY=offset-budget,caller-listing: offset counts against the budget too (→ listing, pre-1715)', async () => {
      // offset-budget only changes the arithmetic; under the lock the budget trigger
      // itself needs caller-listing (round 2, A1) — both are part of SOFTY_LEGACY=all.
      process.env.SOFTY_MAX_DETAIL_FETCHES = '25';
      process.env.SOFTY_LEGACY = 'offset-budget,caller-listing';
      const res = await service.scrape(input({ offset: 20, resultsWanted: 10, descriptionDepth: 'detail-all' }));
      expect(fake.calls[0]).toBe(PAGE(1));
      expect(res.diagnostics).toBeUndefined();

      process.env.SOFTY_LEGACY = 'offset-budget';
      fake.calls.length = 0;
      await service.scrape(input({ offset: 20, resultsWanted: 10, descriptionDepth: 'detail-all' }));
      expect(fake.calls[0]).toBe(SITEMAP);
    });

    it('keeps the sitemap when the budget covers resultsWanted', async () => {
      const res = await service.scrape(input({ resultsWanted: 5, descriptionDepth: 'detail-25' }));
      expect(fake.calls[0]).toBe(SITEMAP);
      expect(res.jobs).toHaveLength(5);
    });

    it('SOFTY_MAX_LIST_PAGES=0: auto never reads a list page (board → sitemap + note; empty sitemap → nothing more)', async () => {
      process.env.SOFTY_MAX_LIST_PAGES = '0';
      const board = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(board.diagnostics?.reason).toBe('partial');

      const tenant = useClient(FakeSofty.acme().set(SITEMAP, '<urlset></urlset>'));
      service.clearCaches();
      await service.scrape(input({ resultsWanted: 2 }));
      expect(tenant.calls).toEqual([SITEMAP]);
    });
  });

  // ── tenant validation ───────────────────────────────────────────────────────

  describe('tenant validation (the slug builds the host)', () => {
    it.each(['x#', 'x/', 'x?', 'x@y', 'a.b', 'attacker.example/#', 'redis.ever-jobs-prod#', '-bad', 'bad-', 'a'.repeat(64)])(
      'refuses companySlug %j: bad_input, no request sent',
      async (slug) => {
        const res = await service.scrape(input({ companySlug: slug }));
        expect(res.jobs).toEqual([]);
        expect(res.diagnostics?.reason).toBe('bad_input');
        expect(fake.calls).toEqual([]);
        expect(mockCreateHttpClient).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a plain label (any case)', { companySlug: 'ACME' }],
      ['a board URL as the slug', { companySlug: 'https://acme.softy.pro/offers' }],
      ['a companyUrl', { companySlug: undefined, companyUrl: 'https://acme.softy.pro/offres' }],
    ])('accepts %s', async (_label, overrides) => {
      const res = await service.scrape(input({ ...overrides, descriptionDepth: 'board' }));
      expect(res.diagnostics).toBeUndefined();
      expect(fake.calls[0]).toBe(PAGE(1));
    });
  });

  // ── politeness ──────────────────────────────────────────────────────────────

  describe('politeness', () => {
    it('never has more than one request in flight (sitemap)', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toHaveLength(5);
      expect(fake.maxInFlight).toBe(1);
    });

    it('never has more than one request in flight (listing, 42 details)', async () => {
      const page1 = Array.from({ length: 21 }, (_, i) => 4000 + i);
      const page2 = Array.from({ length: 21 }, (_, i) => 4021 + i);
      fake.set(PAGE(1), generatedPage(page1, 1, 2)).set(PAGE(2), generatedPage(page2, 2, 2));
      [...page1, ...page2].forEach((id) => fake.set(OFFER(id), detailPage(String(id))));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 100 }));
      expect(res.jobs).toHaveLength(42);
      expect(fake.detailCalls()).toHaveLength(42);
      expect(fake.maxInFlight).toBe(1);
    });

    it('a 429 on a detail page stops further requests but keeps every listed card (rate_limited)', async () => {
      fake.set(OFFER(1002), { status: 429, headers: { 'retry-after': '120' } });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001), OFFER(1002)]);
      expect(res.jobs).toHaveLength(5);
      expect(res.jobs[0].description).toContain('Concevoir des API');
      expect(res.jobs[1].description).toBe('Paris');
      expect(res.diagnostics?.reason).toBe('rate_limited');
      expect(res.diagnostics?.detail).toContain('429');
    });

    it('a cooling-down bucket on the sitemap stops the scrape (no listing fallback)', async () => {
      fake.set(SITEMAP, new HostCoolingDownError('domain:softy.pro', 120000, 429));
      const res = await service.scrape(input({ resultsWanted: 5 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
      expect(res.diagnostics?.detail).toContain('back off');
    });

    it('a crawl-policy refusal mid-pagination keeps the cards already read', async () => {
      fake.set(PAGE(2), new HostCoolingDownError('domain:softy.pro', 90000, 503));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('stops after SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES failure(s) in a row: 1 by default (FR-6)', async () => {
      for (const id of Object.keys(TITLES)) fake.set(OFFER(id), { status: 502 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001)]);
      expect(res.jobs).toHaveLength(5); // the cards, board-only
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3 restores the pre-1715 limit; 0 never stops early', async () => {
      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '3';
      for (const id of Object.keys(TITLES)) fake.set(OFFER(id), { status: 502 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toHaveLength(3);
      expect(res.jobs).toHaveLength(5);
      expect(res.diagnostics?.reason).toBe('fetch_error');

      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '0';
      const again = useClient(FakeSofty.acme());
      for (const id of Object.keys(TITLES)) again.set(OFFER(id), { status: 502 });
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(again.detailCalls()).toHaveLength(5);
    });

    it('stops when the scrape context is aborted', async () => {
      const controller = new AbortController();
      mockGetScrapeContext.mockReturnValue({ signal: controller.signal });
      mockGetEffectiveCrawlPolicy.mockReturnValue({ discovery: 'listing' });
      fake.onRequest = (url) => {
        if (url === OFFER(1001)) controller.abort();
      };
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2), OFFER(1001)]);

      const before = fake.calls.length;
      await service.scrape(input());
      expect(fake.calls.length).toBe(before);
    });
  });

  // ── page stage (Spec 1715 §7.4) ─────────────────────────────────────────────

  describe('page stage push-back (Spec 1715 §7.4)', () => {
    const sitemapScrape = (extra: Record<string, unknown> = {}) =>
      service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3, ...extra }));

    it('a 403 detail page stops the scrape: blocked, nothing after it', async () => {
      fake.set(OFFER(1005), { status: 403 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it.each([401, 407])('a %s detail page stops the scrape as blocked', async (status) => {
      fake.set(OFFER(1005), { status });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('SOFTY_LEGACY=block-as-missing: a 403 detail page is skipped like a 404 (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'block-as-missing';
      fake.set(OFFER(1005), { status: 403 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001), OFFER(1002), OFFER(1003)]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a challenge page served as a detail page stops the scrape: blocked', async () => {
      fake.set(OFFER(1005), fixture('challenge.html'));
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('a real page that merely carries a bot-detection script is not a block', async () => {
      const withScript = detailPage('1005').replace('</head>', '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head>');
      fake.set(OFFER(1005), withScript);
      const res = await sitemapScrape({ resultsWanted: 1 });
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a challenge page as listing page 1 stops the scrape: blocked, no legacy index', async () => {
      fake.set(PAGE(1), fixture('challenge.html'));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('SOFTY_LEGACY=block-as-missing: a challenge listing page leads to the legacy index (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'block-as-missing';
      fake.set(PAGE(1), fixture('challenge.html'));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(fake.calls).toEqual([PAGE(1), LEGACY_INDEX]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a 503 detail page stops the scrape: rate_limited', async () => {
      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '3';
      for (const id of Object.keys(TITLES)) fake.set(OFFER(id), { status: 503 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('SOFTY_LEGACY=503-as-failure: a 503 is a plain failure, the walk goes on to the limit (pre-1715)', async () => {
      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '3';
      process.env.SOFTY_LEGACY = '503-as-failure';
      for (const id of Object.keys(TITLES)) fake.set(OFFER(id), { status: 503 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001), OFFER(1002)]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a 502 then a 429 reports rate_limited, not the earlier 502 (FR-8)', async () => {
      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '3';
      fake.set(OFFER(1005), { status: 502 }).set(OFFER(1001), { status: 429 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001)]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('a 502 on a detail page: the next one is not requested (default limit 1)', async () => {
      fake.set(OFFER(1005), { status: 502 });
      const res = await sitemapScrape();
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a 500 on listing page 2: page 1 cards returned board-only, no detail request', async () => {
      fake.set(PAGE(2), { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.jobs[0].description).toBe('Toulouse');
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('SOFTY_LEGACY=listing-failure-details: the cards read so far still get their detail pages (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'listing-failure-details';
      fake.set(PAGE(2), { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2), OFFER(1001), OFFER(1002), OFFER(1003)]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('detail GETs are capped at resultsWanted + SOFTY_DETAIL_ATTEMPT_SLACK (FR-7)', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => 5000 + i);
      fake.set(SITEMAP, generatedSitemap(ids)); // no detail route: every offer answers 404
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 2 }));
      expect(fake.detailCalls()).toHaveLength(7);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('partial');
      expect(res.diagnostics?.detail).toContain('capped at 7');
    });

    it('SOFTY_DETAIL_ATTEMPT_SLACK=100: every sitemap entry is tried (pre-1715)', async () => {
      process.env.SOFTY_DETAIL_ATTEMPT_SLACK = '100';
      const ids = Array.from({ length: 10 }, (_, i) => 5000 + i);
      fake.set(SITEMAP, generatedSitemap(ids));
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 2 }));
      expect(fake.detailCalls()).toHaveLength(10);
      expect(res.diagnostics).toBeUndefined();
    });
  });

  // ── detail cache ────────────────────────────────────────────────────────────

  describe('caches', () => {
    it('a repeat scrape within 10 min sends nothing (sitemap cache, FR-12)', async () => {
      const first = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.detailCalls()).toHaveLength(3);
      fake.calls.length = 0;
      const second = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.calls).toEqual([]);
      expect(second.jobs.map((j) => j.description)).toEqual(first.jobs.map((j) => j.description));
    });

    it('SOFTY_SITEMAP_CACHE_TTL_MS=0: a repeat sitemap scrape re-reads only the sitemap (pre-1715)', async () => {
      process.env.SOFTY_SITEMAP_CACHE_TTL_MS = '0';
      const first = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.detailCalls()).toHaveLength(3);
      fake.calls.length = 0;
      const second = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(second.jobs.map((j) => j.description)).toEqual(first.jobs.map((j) => j.description));
    });

    it('the sitemap is read again once its cache entry is 10 min old', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await service.scrape(input({ resultsWanted: 1 }));
      fake.calls.length = 0;
      now += 599_999;
      await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls).toEqual([]);
      now += 1;
      await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls).toEqual([SITEMAP]);
    });

    it('re-reads only the offer whose lastmod changed', async () => {
      process.env.SOFTY_SITEMAP_CACHE_TTL_MS = '0';
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      fake.set(SITEMAP, fixture('sitemap.xml').replace('2026-09-20 09:30:00', '2026-09-23 08:00:00'));
      fake.set(OFFER(1001), detailPage('1001', 'Développeur Full-Stack Senior - H/F'));
      fake.calls.length = 0;
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1001)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1005', '1002']);
      expect(res.jobs[0].title).toBe('Développeur Full-Stack Senior - H/F');
      expect(res.jobs[0].datePosted).toBe('2026-09-23');
    });

    it('cache hits do not count against the detail budget', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      process.env.SOFTY_MAX_DETAIL_FETCHES = '1';
      fake.calls.length = 0;
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toEqual([OFFER(1003)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1005', '1001', '1002', '1003']);
    });

    it('listing mode caches by URL', async () => {
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      fake.calls.length = 0;
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs[0].description).toContain('Concevoir des API');
    });

    it('SOFTY_DETAIL_CACHE_MAX=0 disables the cache', async () => {
      process.env.SOFTY_DETAIL_CACHE_MAX = '0';
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 2 }));
      fake.calls.length = 0;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 2 }));
      expect(fake.detailCalls()).toHaveLength(2);
    });

    it('an explicit SOFTY_DETAIL_CACHE_TTL_MS expires every entry after it', async () => {
      process.env.SOFTY_DETAIL_CACHE_TTL_MS = '1000';
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      fake.calls.length = 0;
      now += 999;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([]);
      now += 1;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([OFFER(1005)]);
    });

    it('SOFTY_DETAIL_CACHE_TTL_MS unset: sitemap entries do not expire (FR-13)', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      fake.calls.length = 0;
      now += 7 * 60 * 60 * 1000;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.calls).toEqual([SITEMAP]); // the sitemap cache expired; the detail entry did not
    });

    it('SOFTY_DETAIL_CACHE_TTL_MS=21600000: sitemap entries expire after 6 h (pre-1715)', async () => {
      process.env.SOFTY_DETAIL_CACHE_TTL_MS = '21600000';
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      fake.calls.length = 0;
      now += 7 * 60 * 60 * 1000;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
    });

    it('SOFTY_DETAIL_CACHE_TTL_MS unset: listing entries keep a 6 h expiry', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 1 }));
      fake.calls.length = 0;
      now += 6 * 60 * 60 * 1000 - 1;
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([]);
      now += 1;
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001)]);
    });

    it('clearDetailCache() forgets every detail page', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      service.clearDetailCache();
      fake.calls.length = 0;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([OFFER(1005)]);
    });

    it('clearCaches() forgets the detail pages, the sitemaps and the unknown tenants', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      service.clearCaches();
      fake.calls.length = 0;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005)]);
    });

    it('does not cache failed detail pages', async () => {
      fake.set(OFFER(1005), { status: 500 });
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      fake.set(OFFER(1005), detailPage('1005'));
      fake.calls.length = 0;
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([OFFER(1005)]);
      expect(res.jobs[0].atsId).toBe('1005');
    });
  });

  // ── fresh-fetch signal ──────────────────────────────────────────────────────

  describe('jobUrlFetchedAt (Spec 1715 FR-15)', () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

    it('is set on every post whose detail page this scrape fetched, and never on a cache hit', async () => {
      const first = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(first.jobs).toHaveLength(3);
      for (const job of first.jobs) expect(job.jobUrlFetchedAt).toMatch(ISO);

      const again = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(again.jobs).toHaveLength(3);
      for (const job of again.jobs) expect(job.jobUrlFetchedAt).toBeUndefined();
    });

    it('is set on the listing path, absent on board-only posts', async () => {
      const detailed = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      for (const job of detailed.jobs) expect(job.jobUrlFetchedAt).toMatch(ISO);
      service.clearCaches();
      const board = await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board', resultsWanted: 2 }));
      for (const job of board.jobs) expect(job.jobUrlFetchedAt).toBeUndefined();
    });

    it('is set on legacy cards (the fetched URL is the jobUrl)', async () => {
      const LEGACY = 'https://legacy.softy.pro';
      useClient(
        new FakeSofty()
          .set(`${LEGACY}/offers`, fixture('legacy-offres.html'))
          .set(`${LEGACY}/offers/208303`, fixture('legacy-detail.html')),
      );
      const res = await service.scrape(input({ companySlug: 'legacy', crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      expect(res.jobs[0].jobUrl).toBe(`${LEGACY}/offers/208303`);
      expect(res.jobs[0].jobUrlFetchedAt).toMatch(ISO);
      expect(res.jobs[1].jobUrlFetchedAt).toBeUndefined(); // its page answered 404
    });
  });

  // ── listed-in-a-sitemap signal (round 2, A3) ─────────────────────────────────

  describe('jobUrlListedAt (round 2, A3)', () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('is set on every post taken from a sitemap: when the sitemap answered, before any detail page', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(res.jobs).toHaveLength(3);
      const listedAt = res.jobs[0].jobUrlListedAt as string;
      expect(listedAt).toMatch(ISO);
      for (const job of res.jobs) {
        expect(job.jobUrlListedAt).toBe(listedAt); // one sitemap listed them all
        expect(Date.parse(job.jobUrlFetchedAt as string)).toBeGreaterThanOrEqual(Date.parse(listedAt));
      }
    });

    it('keeps the network time of the sitemap on a sitemap-cache hit (not the time of the hit)', async () => {
      const first = await service.scrape(input({ resultsWanted: 2 }));
      const listedAt = first.jobs[0].jobUrlListedAt as string;
      expect(listedAt).toMatch(ISO);
      await pause(25);
      fake.calls.length = 0;
      const again = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([]); // sitemap and details both from the caches
      expect(again.jobs.map((j) => j.jobUrlListedAt)).toEqual([listedAt, listedAt]);
      expect(again.jobs.map((j) => j.jobUrlFetchedAt)).toEqual([undefined, undefined]);
    });

    it('SOFTY_SITEMAP_CACHE_TTL_MS=0: every scrape re-reads the sitemap, so it carries the new time', async () => {
      process.env.SOFTY_SITEMAP_CACHE_TTL_MS = '0';
      const first = await service.scrape(input({ resultsWanted: 1 }));
      await pause(25);
      const again = await service.scrape(input({ resultsWanted: 1 }));
      expect(Date.parse(again.jobs[0].jobUrlListedAt as string)).toBeGreaterThan(
        Date.parse(first.jobs[0].jobUrlListedAt as string),
      );
    });

    it('is the time the ROOT sitemap answered for a sitemap index (the children answer later)', async () => {
      const requestedAt: Record<string, number> = {};
      fake.set(SITEMAP, fixture('sitemap-index.xml')).set(`${BASE}/sitemap-offers.xml`, fixture('sitemap.xml'));
      fake.onRequest = (url) => {
        requestedAt[url] = Date.now();
      };
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      const listed = Date.parse(res.jobs[0].jobUrlListedAt as string);
      expect(listed).toBeGreaterThanOrEqual(requestedAt[SITEMAP]);
      expect(listed).toBeLessThanOrEqual(requestedAt[`${BASE}/sitemap-offers.xml`]);
    });

    it('is not set on the listing path (no sitemap listed the offer)', async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 2 }));
      expect(res.jobs).toHaveLength(2);
      for (const job of res.jobs) expect(job.jobUrlListedAt).toBeUndefined();
    });
  });

  // ── legacy markup ───────────────────────────────────────────────────────────

  describe('legacy markup fallback', () => {
    const LEGACY = 'https://legacy.softy.pro';

    /** The legacy tenant; its detail pages answer on the `/offre/{ID}-{slug}` link and on its 301 target `/offers/{ID}`. */
    function legacyTenant(): FakeSofty {
      return new FakeSofty()
        .set(`${LEGACY}/offers`, fixture('legacy-offres.html'))
        .set(`${LEGACY}/offres`, fixture('legacy-offres.html'))
        .set(`${LEGACY}/offre/208303-manager-it-workplace-h-f`, fixture('legacy-detail.html'))
        .set(`${LEGACY}/offers/208303`, fixture('legacy-detail.html'));
    }

    it('reads the legacy index at /offers when /offers?page=1 is missing, detail pages at /offers/{ID} (FR-14, A0)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'missing';
      const legacy = useClient(legacyTenant());
      const res = await service.scrape(input({ companySlug: 'legacy', descriptionFormat: DescriptionFormat.PLAIN }));
      // The /offre/{ID}-{slug} links 301 to /offers/{ID}; requesting the target keeps
      // every detail GET one paced request (no hop inside the same limiter slot).
      expect(legacy.calls).toEqual([
        `${LEGACY}/sitemap.xml`,
        `${LEGACY}/offers?page=1`,
        `${LEGACY}/offers`,
        `${LEGACY}/offers/208303`,
        `${LEGACY}/offers/208304`,
      ]);
      expect(legacy.calls.some((u) => u.includes('/offre/'))).toBe(false);
      expect(res.diagnostics).toBeUndefined();
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-208303', 'softy-208304']);
      expect(res.jobs[0]).toMatchObject({
        title: 'Manager It Workplace H/F',
        jobUrl: `${LEGACY}/offers/208303`,
        applyUrl: `${LEGACY}/offers/208303`,
        employmentType: 'CDI',
        datePosted: '2026-06-03',
        emails: ['rh@legacy.example'],
      });
      expect(res.jobs[0].description).toContain('piloter le poste de travail');
      expect(res.jobs[0].description).not.toContain('do not keep');
      expect(res.jobs[1]).toMatchObject({
        jobUrl: `${LEGACY}/offers/208304`,
        employmentType: 'Stage - 6 Mois',
        datePosted: '2026-06-01',
      });
    });

    it('SOFTY_LEGACY=legacy-detail-url: legacy cards link /offre/{ID}-{slug} again (pre-1715; red control of A0)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'missing';
      process.env.SOFTY_LEGACY = 'legacy-detail-url';
      const legacy = useClient(legacyTenant());
      const res = await service.scrape(input({ companySlug: 'legacy', descriptionFormat: DescriptionFormat.PLAIN }));
      expect(legacy.calls.slice(3)).toEqual([
        `${LEGACY}/offre/208303-manager-it-workplace-h-f`,
        `${LEGACY}/offre/208304-charge-e-marketing-digital`,
      ]);
      expect(res.jobs.map((j) => j.jobUrl)).toEqual([
        `${LEGACY}/offre/208303-manager-it-workplace-h-f`,
        `${LEGACY}/offre/208304-charge-e-marketing-digital`,
      ]);
    });

    it('SOFTY_SITEMAP_FALLBACK=any-error + SOFTY_LEGACY=offres,legacy-detail-url: the pre-1715 sequence via /offres', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      process.env.SOFTY_LEGACY = 'offres,legacy-detail-url';
      const legacy = useClient(legacyTenant());
      const res = await service.scrape(input({ companySlug: 'legacy', descriptionFormat: DescriptionFormat.PLAIN }));
      expect(legacy.calls).toEqual([
        `${LEGACY}/sitemap.xml`,
        `${LEGACY}/offers?page=1`,
        `${LEGACY}/offres`,
        `${LEGACY}/offre/208303-manager-it-workplace-h-f`,
        `${LEGACY}/offre/208304-charge-e-marketing-digital`,
      ]);
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-208303', 'softy-208304']);
    });

    it('parses legacy links served on /offers without another request', async () => {
      const legacy = useClient(new FakeSofty().set(`${LEGACY}/offers?page=1`, fixture('legacy-offres.html')));
      const res = await service.scrape(input({ companySlug: 'legacy', crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(legacy.calls).toEqual([`${LEGACY}/offers?page=1`]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['208303', '208304']);
    });

    it('does not look for the legacy index on an empty current board', async () => {
      fake.set(PAGE(1), fixture('listing-empty.html'));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('respects resultsWanted on the legacy index', async () => {
      useClient(legacyTenant());
      const res = await service.scrape(input({ companySlug: 'legacy', resultsWanted: 1, descriptionDepth: 'board' }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['208303']);
    });
  });

  // ── descriptions ────────────────────────────────────────────────────────────

  describe('descriptions', () => {
    const scrapeOne = (format?: DescriptionFormat) =>
      service
        .scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1, descriptionFormat: format }))
        .then((r) => r.jobs[0].description ?? '');

    it('html keeps the cleaned .prose sections with their h2 headings', async () => {
      const html = await scrapeOne(DescriptionFormat.HTML);
      expect(html).toContain("<h2>L'entreprise</h2>");
      expect(html).toContain('<ul><li>Concevoir des API</li><li>Livrer en continu</li></ul>');
      expect(html).not.toMatch(/class=|style=|<script|<button/);
    });

    it('markdown and plain carry the same content without tags', async () => {
      service.clearDetailCache();
      const md = await scrapeOne(DescriptionFormat.MARKDOWN);
      expect(md).toContain("L'entreprise");
      expect(md).toMatch(/Concevoir des API/);
      expect(md).not.toContain('<');
      const plain = await scrapeOne(DescriptionFormat.PLAIN);
      expect(plain).toContain('Vos missions');
      expect(plain).toContain('• Concevoir des API');
      expect(plain).not.toContain('<');
      const unset = await scrapeOne(undefined);
      expect(unset).toBe(plain);
    });

    it('caps every format at 8,000 characters', async () => {
      const long = `<h2>Big</h2><div class="prose">${`<p>${'Lorem ipsum dolor sit amet. '.repeat(12)}</p>`.repeat(80)}</div>`;
      fake.set(OFFER(1005), `<html><body><h1>Big one</h1>${long}</body></html>`);
      for (const format of [DescriptionFormat.HTML, DescriptionFormat.MARKDOWN, DescriptionFormat.PLAIN]) {
        service.clearDetailCache();
        const d = await scrapeOne(format);
        expect(d.length).toBeGreaterThan(1000);
        expect(d.length).toBeLessThanOrEqual(SOFTY_DESCRIPTION_MAX_CHARS);
      }
    });

    it('falls back to og:description when the page has no .prose', async () => {
      fake.set(OFFER(1005), detailPage('1005').replace(/class="prose[^"]*"/g, 'class="x"'));
      const d = await scrapeOne(DescriptionFormat.PLAIN);
      expect(d).toBe('Rejoignez ACME en tant que Stagiaire Comptabilité.');
    });
  });

  // ── discovery resolution ────────────────────────────────────────────────────

  describe('discovery resolution (Spec 1690 layers, Spec 1715 FR-3)', () => {
    it("outside JobsService the caller's crawl.discovery goes through the resolver (the lock decides)", async () => {
      // The real resolver refuses a caller `listing` under the Softy lock (softy.policy.spec.ts).
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'sitemap' });
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 1 }));
      expect(mockResolveCrawlPolicy).toHaveBeenCalledWith({
        site: Site.SOFTY,
        host: 'acme.softy.pro',
        plugin: SOFTY_CRAWL_POLICY,
        caller: { discovery: 'listing' },
      });
      expect(fake.calls[0]).toBe(SITEMAP);
    });

    it('outside a scrape context the resolved site/host policy applies', async () => {
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'listing' });
      await service.scrape(input({ resultsWanted: 1 }));
      expect(mockResolveCrawlPolicy).toHaveBeenCalledWith({
        site: Site.SOFTY,
        host: 'acme.softy.pro',
        plugin: SOFTY_CRAWL_POLICY,
      });
      expect(fake.calls[0]).toBe(PAGE(1));
    });

    it("inside a scrape context the context's effective policy decides", async () => {
      mockGetScrapeContext.mockReturnValue({ site: 'softy', caller: { discovery: 'sitemap' } });
      mockGetEffectiveCrawlPolicy.mockReturnValue({ discovery: 'listing' });
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(mockGetEffectiveCrawlPolicy).toHaveBeenCalledWith('acme.softy.pro');
      expect(mockResolveCrawlPolicy).not.toHaveBeenCalled();
      expect(fake.calls[0]).toBe(PAGE(1));
    });

    it("falls back to the context's caller value when the resolver fails", async () => {
      mockGetScrapeContext.mockReturnValue({ caller: { discovery: 'listing' } });
      mockGetEffectiveCrawlPolicy.mockImplementation(() => {
        throw new Error('not implemented');
      });
      await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls[0]).toBe(PAGE(1));
    });

    it('falls back to EVER_JOBS_CRAWL_DISCOVERY, then auto, when no resolver is available', async () => {
      mockResolveCrawlPolicy.mockImplementation(() => {
        throw new Error('not implemented');
      });
      mockGetScrapeContext.mockImplementation(() => {
        throw new Error('not implemented');
      });
      process.env.EVER_JOBS_CRAWL_DISCOVERY = ' Listing ';
      await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls[0]).toBe(PAGE(1));

      process.env.EVER_JOBS_CRAWL_DISCOVERY = 'bogus';
      fake.calls.length = 0;
      await service.scrape(input({ resultsWanted: 1 }));
      expect(fake.calls[0]).toBe(SITEMAP);
    });

    it('opens its own scrape context (plugin policy + caller crawl) when called directly', async () => {
      await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board', resultsWanted: 1 }));
      expect(mockRunWithScrapeContext).toHaveBeenCalledTimes(1);
      expect(mockRunWithScrapeContext.mock.calls[0][0]).toEqual({
        site: Site.SOFTY,
        plugin: SOFTY_CRAWL_POLICY,
        caller: { discovery: 'listing' },
      });
      expect(fake.calls).toEqual([PAGE(1)]);
    });

    it('resolves discovery inside the scrape context it opened (FR-3)', async () => {
      const ctx = { site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' } };
      let inside = false;
      mockRunWithScrapeContext.mockImplementation(async (_c: unknown, fn: () => Promise<unknown>) => {
        inside = true;
        try {
          return await fn();
        } finally {
          inside = false;
        }
      });
      mockGetScrapeContext.mockImplementation(() => (inside ? ctx : undefined));
      mockGetEffectiveCrawlPolicy.mockReturnValue({ discovery: 'sitemap' });
      await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 1 }));
      expect(mockGetEffectiveCrawlPolicy).toHaveBeenCalledWith('acme.softy.pro');
      expect(mockResolveCrawlPolicy).not.toHaveBeenCalled();
      expect(fake.calls[0]).toBe(SITEMAP);
    });

    it('does not open a scrape context inside an existing one', async () => {
      mockGetScrapeContext.mockReturnValue({ site: 'softy' });
      await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 1 }));
      expect(mockRunWithScrapeContext).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([PAGE(1)]);
    });

    it('still scrapes (once) when a scrape context cannot be opened', async () => {
      mockRunWithScrapeContext.mockImplementation(() => {
        throw new Error('not implemented');
      });
      const res = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 1 }));
      expect(res.jobs).toHaveLength(1);
      expect(fake.calls).toEqual([PAGE(1)]);
    });

    it('ignores an invalid caller value', async () => {
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'listing' });
      await service.scrape(input({ crawl: { discovery: 'everything' }, resultsWanted: 1 }));
      expect(fake.calls[0]).toBe(PAGE(1));
    });
  });

  // ── tenant resolution & failure semantics ───────────────────────────────────

  describe('tenant resolution', () => {
    it.each([
      [{ companySlug: 'ACME' }],
      [{ companySlug: ' acme ' }],
      [{ companySlug: 'https://acme.softy.pro/offres' }],
      [{ companySlug: 'acme.softy.pro' }],
      [{ companySlug: undefined, companyUrl: 'https://acme.softy.pro/offers/1001' }],
      [{ companySlug: undefined, companyUrl: 'acme.softy.pro' }],
    ])('resolves %j to acme', async (overrides) => {
      await service.scrape(input({ ...overrides, descriptionDepth: 'board', resultsWanted: 1 }));
      expect(fake.calls[0]).toBe(PAGE(1));
    });

    it.each([
      [{ companySlug: undefined, companyUrl: undefined }],
      [{ companySlug: undefined, companyUrl: 'https://example.com/jobs' }],
      [{ companySlug: undefined, companyUrl: 'https://www.softy.pro' }],
      [{ companySlug: undefined, companyUrl: 'not a url at all' }],
    ])('returns empty without any request for %j', async (overrides) => {
      const res = await service.scrape(input(overrides));
      expect(res.jobs).toEqual([]);
      expect(mockCreateHttpClient).not.toHaveBeenCalled();
    });

    it('resultsWanted 0 sends nothing', async () => {
      const res = await service.scrape(input({ resultsWanted: 0 }));
      expect(res.jobs).toEqual([]);
      expect(fake.calls).toEqual([]);
    });

    it('defaults resultsWanted to SOFTY_DEFAULT_RESULTS when unset', async () => {
      const raw = input({ descriptionDepth: 'board' });
      delete (raw as { resultsWanted?: number }).resultsWanted;
      const res = await service.scrape(raw);
      expect(res.jobs).toHaveLength(5);
    });
  });

  describe('failure semantics', () => {
    it('a tenant without a sitemap (404 everywhere): one request, bad_input', async () => {
      const unknown = useClient(new FakeSofty());
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(unknown.calls).toEqual(['https://nobody.softy.pro/sitemap.xml']);
    });

    it('SOFTY_SITEMAP_FALLBACK=any-error + SOFTY_LEGACY=offres: an empty board after 3 requests (pre-1715)', async () => {
      process.env.SOFTY_SITEMAP_FALLBACK = 'any-error';
      process.env.SOFTY_LEGACY = 'offres';
      const unknown = useClient(new FakeSofty());
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(unknown.calls).toEqual([
        'https://nobody.softy.pro/sitemap.xml',
        'https://nobody.softy.pro/offers?page=1',
        'https://nobody.softy.pro/offres',
      ]);
    });

    it('a 5xx on page 2 keeps page 1 with a diagnostic (partial)', async () => {
      fake.set(PAGE(2), { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a 503 on page 1 is empty with rate_limited', async () => {
      fake.set(PAGE(1), { status: 503 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(res.jobs).toEqual([]);
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.diagnostics?.reason).toBe('rate_limited');
    });

    it('SOFTY_LEGACY=503-as-failure: a 503 on page 1 is a plain fetch_error (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = '503-as-failure';
      fake.set(PAGE(1), { status: 503 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a non-text body is treated as missing', async () => {
      fake.get.mockImplementationOnce(async (url: string) => {
        fake.calls.push(url);
        return { data: { json: true }, status: 200, headers: {} } as any;
      });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), LEGACY_INDEX]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('SOFTY_LEGACY=offres: the legacy index is requested at /offres (pre-1715)', async () => {
      process.env.SOFTY_LEGACY = 'offres';
      fake.set(PAGE(1), { status: 404 });
      await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), LEGACY_OFFRES]);
    });
  });
});
