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

import { HostCoolingDownError } from '@ever-jobs/common';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { SoftyService } from '../src/softy.service';
import {
  SOFTY_BROWSER_USER_AGENT,
  SOFTY_CRAWL_POLICY,
  SOFTY_DESCRIPTION_MAX_CHARS,
  SOFTY_ENV,
  SOFTY_HEADERS,
} from '../src/softy.constants';

// ── fixtures & fake Softy server ─────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const BASE = 'https://acme.softy.pro';
const SITEMAP = `${BASE}/sitemap.xml`;
const PAGE = (n: number) => `${BASE}/offers?page=${n}`;
const OFFER = (id: string | number) => `${BASE}/offers/${id}`;
const LEGACY_INDEX = `${BASE}/offres`;

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

const ENV_KEYS = [...Object.values(SOFTY_ENV), 'EVER_JOBS_CRAWL_DISCOVERY'];

describe('SoftyService (Spec 1691)', () => {
  let fake: FakeSofty;
  let service: SoftyService;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    fake = FakeSofty.acme();
    service = new SoftyService();
    mockCreateHttpClient.mockReset().mockImplementation(() => fake);
    mockGetScrapeContext.mockReset().mockReturnValue(undefined);
    mockGetEffectiveCrawlPolicy.mockReset().mockReturnValue({ discovery: 'auto' });
    mockResolveCrawlPolicy.mockReset().mockReturnValue({ discovery: 'auto' });
    mockRunWithScrapeContext.mockReset().mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.restoreAllMocks();
  });

  // ── manifest & identity ─────────────────────────────────────────────────────

  describe('manifest and identity', () => {
    it('declares the Softy crawl policy in @SourcePlugin', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, SoftyService);
      expect(meta).toMatchObject({ site: Site.SOFTY, name: 'Softy', category: 'ats', isAts: true });
      expect(meta.crawl).toEqual({ rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 });
      expect(meta.crawl).toBe(SOFTY_CRAWL_POLICY);
    });

    it('no longer puts the browser UA in SOFTY_HEADERS; it only declares it', async () => {
      expect(Object.keys(SOFTY_HEADERS).map((k) => k.toLowerCase())).toEqual(['accept', 'accept-language']);
      expect(SOFTY_BROWSER_USER_AGENT).toContain('Chrome/129');
      await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(fake.setHeaders).toHaveBeenCalledTimes(1);
      expect(fake.setHeaders).toHaveBeenCalledWith({ ...SOFTY_HEADERS, 'User-Agent': SOFTY_BROWSER_USER_AGENT });
    });

    it('builds the client from the caller proxies / CA / timeout', async () => {
      await service.scrape(input({ proxies: ['p1:8080'], caCert: 'ca', requestTimeout: 12, descriptionDepth: 'board' }));
      expect(mockCreateHttpClient).toHaveBeenCalledWith({ proxies: ['p1:8080'], caCert: 'ca', timeout: 12 });
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
      expect(dev.description).toContain('Concevoir des API');
      expect(pmo).toMatchObject({ title: 'Chef de projet & PMO - H/F', employmentType: 'CDD - 6 Mois', datePosted: '2026-09-18' });
      expect(alt).toMatchObject({ employmentType: 'Apprentissage - 24 Mois' });
      expect(data).toMatchObject({ isRemote: true, datePosted: '2026-09-10' });
      expect(stage).toMatchObject({ jobUrl: OFFER(1005), employmentType: 'Stage - 6 Mois', datePosted: '2026-09-22' });
      expect(stage.location).toMatchObject({ city: 'Nantes' });
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
  });

  // ── auto ────────────────────────────────────────────────────────────────────

  describe('auto discovery', () => {
    it('uses the sitemap when it has offers', async () => {
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP, OFFER(1005), OFFER(1001)]);
      expect(res.jobs).toHaveLength(2);
    });

    it.each([
      ['a 404', { status: 404 } as Route],
      ['an empty urlset', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'],
      ['a sitemap without offers', `<urlset><url><loc>${BASE}</loc></url><url><loc>${PAGE(1)}</loc></url></urlset>`],
      ['garbage', '<!doctype html><html><body>Page introuvable</body></html>'],
      ['a 5xx', { status: 503 } as Route],
      ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ])('falls back to the listing on %s', async (_label, route) => {
      fake.set(SITEMAP, route);
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([SITEMAP, PAGE(1), OFFER(1001), OFFER(1002)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002']);
      expect(res.diagnostics).toBeUndefined();
    });

    it("uses the listing straight away for descriptionDepth 'board'", async () => {
      const res = await service.scrape(input({ descriptionDepth: 'board' }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs).toHaveLength(5);
    });

    it("board depth reads the listing even when discovery is 'sitemap'", async () => {
      const res = await service.scrape(input({ crawl: { discovery: 'sitemap' }, descriptionDepth: 'board', resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toHaveLength(2);
    });

    it('uses the listing when no detail page may be fetched (SOFTY_MAX_DETAIL_FETCHES=0)', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '0';
      const res = await service.scrape(input({ resultsWanted: 2 }));
      expect(fake.calls).toEqual([PAGE(1)]);
      expect(res.jobs).toHaveLength(2);
    });

    it('uses the listing when the detail budget cannot cover every wanted offer (detail-25, resultsWanted 60)', async () => {
      // A 65-offer tenant: the sitemap path would stop at 25 posts; the listing returns 60, 25 of them detailed.
      const ids = Array.from({ length: 65 }, (_, i) => 4000 + i);
      const pages = [ids.slice(0, 21), ids.slice(21, 42), ids.slice(42, 63), ids.slice(63)];
      fake.set(SITEMAP, generatedSitemap(ids));
      pages.forEach((pageIds, i) => fake.set(PAGE(i + 1), generatedPage(pageIds, i + 1, pages.length)));
      ids.forEach((id) => fake.set(OFFER(id), detailPage(String(id))));

      const res = await service.scrape(input({ resultsWanted: 60, descriptionDepth: 'detail-25' }));

      expect(fake.calls).not.toContain(SITEMAP);
      expect(res.jobs).toHaveLength(60);
      expect(fake.detailCalls()).toHaveLength(25);
      expect(res.diagnostics).toBeUndefined();
    });

    it('offset counts against the budget too (offset 20 + 10 wanted > 25 → listing)', async () => {
      process.env.SOFTY_MAX_DETAIL_FETCHES = '25';
      const res = await service.scrape(input({ offset: 20, resultsWanted: 10, descriptionDepth: 'detail-all' }));
      expect(fake.calls[0]).toBe(PAGE(1));
      expect(res.diagnostics).toBeUndefined();
    });

    it('keeps the sitemap when the budget covers offset + wanted', async () => {
      const res = await service.scrape(input({ resultsWanted: 5, descriptionDepth: 'detail-25' }));
      expect(fake.calls[0]).toBe(SITEMAP);
      expect(res.jobs).toHaveLength(5);
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

    it('a 429 on a detail page stops further requests but keeps every listed card', async () => {
      fake.set(OFFER(1002), { status: 429, headers: { 'retry-after': '120' } });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toEqual([OFFER(1001), OFFER(1002)]);
      expect(res.jobs).toHaveLength(5);
      expect(res.jobs[0].description).toContain('Concevoir des API');
      expect(res.jobs[1].description).toBe('Paris');
      expect(res.diagnostics?.reason).not.toBe('ok');
      expect(res.diagnostics?.detail).toContain('429');
    });

    it('a cooling-down bucket on the sitemap stops the scrape (no listing fallback)', async () => {
      fake.set(SITEMAP, new HostCoolingDownError('domain:softy.pro', 120000, 429));
      const res = await service.scrape(input({ resultsWanted: 5 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeDefined();
      expect(res.diagnostics?.detail).toContain('back off');
    });

    it('a crawl-policy refusal mid-pagination keeps the cards already read', async () => {
      fake.set(PAGE(2), new HostCoolingDownError('domain:softy.pro', 90000, 503));
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.calls).toEqual([PAGE(1), PAGE(2)]);
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.diagnostics).toBeDefined();
    });

    it('stops fetching detail pages after SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES failures in a row', async () => {
      for (const id of Object.keys(TITLES)) fake.set(OFFER(id), { status: 502 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, resultsWanted: 5 }));
      expect(fake.detailCalls()).toHaveLength(3);
      expect(res.jobs).toHaveLength(5);
      expect(res.diagnostics?.reason).toBe('fetch_error');

      process.env.SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES = '0';
      const again = FakeSofty.acme();
      for (const id of Object.keys(TITLES)) again.set(OFFER(id), { status: 502 });
      mockCreateHttpClient.mockImplementation(() => again);
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

  // ── detail cache ────────────────────────────────────────────────────────────

  describe('detail cache', () => {
    it('a repeat sitemap scrape re-reads only the sitemap', async () => {
      const first = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.detailCalls()).toHaveLength(3);
      fake.calls.length = 0;
      const second = await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 3 }));
      expect(fake.calls).toEqual([SITEMAP]);
      expect(second.jobs.map((j) => j.description)).toEqual(first.jobs.map((j) => j.description));
    });

    it('re-reads only the offer whose lastmod changed', async () => {
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

    it('entries expire after SOFTY_DETAIL_CACHE_TTL_MS', async () => {
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

    it('clearDetailCache() forgets everything', async () => {
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      service.clearDetailCache();
      fake.calls.length = 0;
      await service.scrape(input({ crawl: { discovery: 'sitemap' }, resultsWanted: 1 }));
      expect(fake.detailCalls()).toEqual([OFFER(1005)]);
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

  // ── legacy markup ───────────────────────────────────────────────────────────

  describe('legacy markup fallback', () => {
    const LEGACY = 'https://legacy.softy.pro';

    function legacyTenant(): FakeSofty {
      return new FakeSofty()
        .set(`${LEGACY}/offres`, fixture('legacy-offres.html'))
        .set(`${LEGACY}/offre/208303-manager-it-workplace-h-f`, fixture('legacy-detail.html'));
    }

    it('reads /offres when /offers is missing', async () => {
      const legacy = legacyTenant();
      mockCreateHttpClient.mockImplementation(() => legacy);
      const res = await service.scrape(input({ companySlug: 'legacy', descriptionFormat: DescriptionFormat.PLAIN }));
      expect(legacy.calls).toEqual([
        `${LEGACY}/sitemap.xml`,
        `${LEGACY}/offers?page=1`,
        `${LEGACY}/offres`,
        `${LEGACY}/offre/208303-manager-it-workplace-h-f`,
        `${LEGACY}/offre/208304-charge-e-marketing-digital`,
      ]);
      expect(res.diagnostics).toBeUndefined();
      expect(res.jobs.map((j) => j.id)).toEqual(['softy-208303', 'softy-208304']);
      expect(res.jobs[0]).toMatchObject({
        title: 'Manager It Workplace H/F',
        jobUrl: `${LEGACY}/offre/208303-manager-it-workplace-h-f`,
        employmentType: 'CDI',
        datePosted: '2026-06-03',
        emails: ['rh@legacy.example'],
      });
      expect(res.jobs[0].description).toContain('piloter le poste de travail');
      expect(res.jobs[0].description).not.toContain('do not keep');
      expect(res.jobs[1]).toMatchObject({
        jobUrl: `${LEGACY}/offre/208304-charge-e-marketing-digital`,
        employmentType: 'Stage - 6 Mois',
        datePosted: '2026-06-01',
      });
    });

    it('parses legacy links served on /offers without another request', async () => {
      const legacy = new FakeSofty().set(`${LEGACY}/offers?page=1`, fixture('legacy-offres.html'));
      mockCreateHttpClient.mockImplementation(() => legacy);
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
      const legacy = legacyTenant();
      mockCreateHttpClient.mockImplementation(() => legacy);
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

  describe('discovery resolution (Spec 1690 layers)', () => {
    it("outside a scrape context the caller's crawl.discovery wins", async () => {
      mockResolveCrawlPolicy.mockReturnValue({ discovery: 'sitemap' });
      await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board', resultsWanted: 1 }));
      expect(fake.calls).toEqual([PAGE(1)]);
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
    it('an unknown tenant (404 everywhere) is an empty board with no diagnostic', async () => {
      const unknown = new FakeSofty();
      mockCreateHttpClient.mockImplementation(() => unknown);
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(unknown.calls).toEqual([
        'https://nobody.softy.pro/sitemap.xml',
        'https://nobody.softy.pro/offers?page=1',
        'https://nobody.softy.pro/offres',
      ]);
    });

    it('a host that does not resolve is empty with no diagnostic', async () => {
      const dns = Object.assign(new Error('getaddrinfo ENOTFOUND nobody.softy.pro'), { code: 'ENOTFOUND' });
      const unknown = new FakeSofty();
      unknown.get.mockImplementation(async () => {
        throw dns;
      });
      mockCreateHttpClient.mockImplementation(() => unknown);
      const res = await service.scrape(input({ companySlug: 'nobody' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a 5xx on page 2 keeps page 1 with a diagnostic (partial)', async () => {
      fake.set(PAGE(2), { status: 500 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' }, descriptionDepth: 'board' }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['1001', '1002', '1003']);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a 5xx on page 1 is empty with a diagnostic', async () => {
      fake.set(PAGE(1), { status: 503 });
      const res = await service.scrape(input({ crawl: { discovery: 'listing' } }));
      expect(res.jobs).toEqual([]);
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
  });
});
