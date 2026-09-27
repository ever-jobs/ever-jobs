import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { performance } from 'perf_hooks';
import { DescriptionFormat, JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';
import { resetCrawlPolicyEnvCache, resetEffectiveCrawlPolicyCache, resetHostLimiter } from '@ever-jobs/common';

import { SoftyService } from '../src/softy.service';

/**
 * Spec 1715 §8.2 (audit G26) — the Softy plugin end to end with the REAL
 * `HttpClient`, crawl-policy resolver and host limiter, against a local HTTP server
 * that scripts an answer per path and records when every request arrived and when
 * its answer finished. Only `tenantOrigin` is overridden (the documented test seam,
 * spec D6), so the plugin opens its own scrape context and its manifest paces the
 * loopback "domain" exactly as it paces `softy.pro`. The loopback host is let through
 * the egress guard by its documented allow-list (`EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`).
 * No network beyond 127.0.0.1.
 *
 * Timing assertions are lower bounds only (a loaded runner can only make gaps
 * longer). The two control runs (C1, C2) assert the OLD sequence / spacing under the
 * legacy switches, so S3's and S1's assertions are shown to depend on the defaults.
 */

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const detailPage = (id: number) =>
  fixture('detail.html').replace(/__ID__/g, String(id)).replace(/__TITLE__/g, `Offre ${id}`);

interface Reply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Answer after this many ms (default: the scenario's `delayMs`). */
  delayMs?: number;
}

interface Hit {
  path: string;
  userAgent: string;
  arrivedAt: number;
  finishedAt: number;
}

/** A `SoftyService` whose tenants live on the loopback server. */
class LoopbackSofty extends SoftyService {
  constructor(private readonly originOf: () => string) {
    super();
  }

  protected tenantOrigin(): string {
    return this.originOf();
  }
}

/** Env keys a scenario may read; snapshotted, cleared and restored around every test. */
const ENV_PATTERN = /^(EVER_JOBS_CRAWL_|SOFTY_)/;
const PROXY_KEYS = ['DEFAULT_PROXIES', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

describe('SoftyService with the real HttpClient and limiter (Spec 1715 §8.2)', () => {
  let server: Server;
  let origin = '';
  let routes = new Map<string, Reply>();
  let delayMs = 0;
  let hits: Hit[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let savedEnv: Record<string, string | undefined> = {};
  const service = new LoopbackSofty(() => origin);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const hit: Hit = {
        path: req.url ?? '',
        userAgent: String(req.headers['user-agent'] ?? ''),
        arrivedAt: performance.now(),
        finishedAt: Number.NaN,
      };
      hits.push(hit);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        hit.finishedAt = performance.now();
        inFlight--;
      };
      res.on('finish', finish);
      res.on('close', finish);
      const reply = routes.get(hit.path) ?? { status: 404, body: 'not found' };
      setTimeout(() => {
        const body = reply.body ?? '';
        const type = body.trimStart().startsWith('<?xml') || body.includes('<urlset') ? 'application/xml' : 'text/html';
        res.writeHead(reply.status ?? 200, { 'Content-Type': `${type}; charset=utf-8`, ...(reply.headers ?? {}) });
        res.end(body);
      }, reply.delayMs ?? delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of [...Object.keys(process.env).filter((k) => ENV_PATTERN.test(k)), ...PROXY_KEYS]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS = '127.0.0.1';
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter(); // also clears any cool-down an earlier scenario left
    service.clearCaches();
    routes = new Map();
    delayMs = 0;
    hits = [];
    inFlight = 0;
    maxInFlight = 0;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env).filter((k) => ENV_PATTERN.test(k))) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────

  function env(values: Record<string, string>): void {
    Object.assign(process.env, values);
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  }

  /** A `<urlset>` of `/offers/{id}` on the loopback origin; a higher id is newer. */
  function sitemapOf(ids: number[]): string {
    const urls = ids
      .map((id) => `<url><loc>${origin}/offers/${id}</loc><lastmod>2026-09-${String(10 + id).padStart(2, '0')} 10:00:00</lastmod></url>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  }

  function listingOf(ids: number[]): string {
    const cards = ids
      .map(
        (id) => `<a href="/offers/${id}"><div data-slot="card"><h3 data-slot="joboffer-title">Offre ${id}</h3>
          <div data-slot="joboffer-locations"><p>Dijon</p></div><span data-slot="badge">CDI</span></div></a>`,
      )
      .join('\n');
    return `<!DOCTYPE html><html><body><main>${cards}</main></body></html>`;
  }

  function healthyTenant(ids: number[]): void {
    routes.set('/sitemap.xml', { body: sitemapOf(ids) });
    for (const id of ids) routes.set(`/offers/${id}`, { body: detailPage(id) });
  }

  const scrape = (extra: Record<string, unknown> = {}): Promise<JobResponseDto> =>
    service.scrape(
      new ScraperInputDto({
        siteType: [Site.SOFTY],
        companySlug: 'acme',
        resultsWanted: 2,
        descriptionFormat: DescriptionFormat.PLAIN,
        ...extra,
      } as Partial<ScraperInputDto>),
    );

  const paths = () => hits.map((h) => h.path);
  const startGaps = () => hits.slice(1).map((h, i) => h.arrivedAt - hits[i].arrivedAt);
  const idleGaps = () => hits.slice(1).map((h, i) => h.arrivedAt - hits[i].finishedAt);

  // ── scenarios ────────────────────────────────────────────────────────────────

  it('S1 healthy: sitemap then one detail page per wanted offer, one at a time, ≥ 1 s apart and ≥ 0.5 s idle', async () => {
    delayMs = 700; // the server takes 700 ms per page: the idle gap, not the interval, decides each next start
    healthyTenant([1, 2, 3]);
    const res = await scrape({ resultsWanted: 2 });

    expect(paths()).toEqual(['/sitemap.xml', '/offers/3', '/offers/2']);
    expect(maxInFlight).toBe(1);
    for (const gap of startGaps()) expect(gap).toBeGreaterThanOrEqual(975);
    for (const gap of idleGaps()) expect(gap).toBeGreaterThanOrEqual(475);
    expect(res.jobs.map((j) => j.atsId)).toEqual(['3', '2']);
    for (const job of res.jobs) expect(job.jobUrlFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.diagnostics).toBeUndefined();
    // Ask (A): the honest, configured UA — the declared browser UA is not sent.
    for (const hit of hits) {
      expect(hit.userAgent).toContain('EverJobs');
      expect(hit.userAgent).not.toContain('Chrome');
    }
  }, 10_000);

  it.each([503, 429])('S2 a sitemap %s with Retry-After 3600: one request, rate_limited, no list page', async (status) => {
    routes.set('/sitemap.xml', { status, headers: { 'Retry-After': '3600' }, body: 'slow down' });
    const res = await scrape();
    expect(paths()).toEqual(['/sitemap.xml']);
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('rate_limited');
  }, 10_000);

  it('S3 a sitemap 500: one request, fetch_error, no list page', async () => {
    healthyTenant([1, 2, 3]);
    routes.set('/sitemap.xml', { status: 500, body: 'oops' });
    routes.set('/offers?page=1', { body: listingOf([1, 2, 3]) });
    const res = await scrape();
    expect(paths()).toEqual(['/sitemap.xml']);
    expect(paths()).not.toContain('/offers?page=1');
    expect(res.diagnostics?.reason).toBe('fetch_error');
  }, 10_000);

  it('S4 a sitemap 403: one request, blocked', async () => {
    routes.set('/sitemap.xml', { status: 403, body: 'forbidden' });
    routes.set('/offers?page=1', { body: listingOf([1]) });
    const res = await scrape();
    expect(paths()).toEqual(['/sitemap.xml']);
    expect(res.diagnostics?.reason).toBe('blocked');
  }, 10_000);

  it('S5 a detail page 403: blocked, nothing after it', async () => {
    healthyTenant([1, 2, 3]);
    routes.set('/offers/3', { status: 403, body: 'forbidden' });
    const res = await scrape();
    expect(paths()).toEqual(['/sitemap.xml', '/offers/3']);
    expect(res.diagnostics?.reason).toBe('blocked');
  }, 10_000);

  it('S6 every offer gone (404), wanted 1, SOFTY_DETAIL_ATTEMPT_SLACK=2: sitemap + 3 detail GETs, partial', async () => {
    env({ SOFTY_DETAIL_ATTEMPT_SLACK: '2' });
    routes.set('/sitemap.xml', { body: sitemapOf([1, 2, 3, 4, 5]) });
    const res = await scrape({ resultsWanted: 1 });
    expect(paths()).toEqual(['/sitemap.xml', '/offers/5', '/offers/4', '/offers/3']);
    expect(res.diagnostics?.reason).toBe('partial');
  }, 10_000);

  it('S7 a 2xx empty <urlset>: the listing fallback still exists', async () => {
    routes.set('/sitemap.xml', { body: sitemapOf([]) });
    routes.set('/offers?page=1', { body: listingOf([1, 2, 3]) });
    routes.set('/offers/1', { body: detailPage(1) });
    const res = await scrape({ resultsWanted: 1 });
    expect(paths()).toEqual(['/sitemap.xml', '/offers?page=1', '/offers/1']);
    expect(res.jobs.map((j) => j.atsId)).toEqual(['1']);
  }, 10_000);

  // ── controls: the legacy switches bring the old behaviour back ───────────────

  it('C1 control: S3 under SOFTY_SITEMAP_FALLBACK=any-error + SOFTY_LEGACY=all reads the list page (the old sequence)', async () => {
    // The crawl-policy side is undone by operator policy (spec §7.2): without it the
    // 30 s server-error cool-down would hold the list page back.
    env({
      SOFTY_SITEMAP_FALLBACK: 'any-error',
      SOFTY_LEGACY: 'all',
      EVER_JOBS_CRAWL_POLICIES: JSON.stringify({ sites: { softy: { serverErrorCooldownMs: 0 } } }),
    });
    healthyTenant([1, 2, 3]);
    routes.set('/sitemap.xml', { status: 500, body: 'oops' });
    routes.set('/offers?page=1', { body: listingOf([1, 2, 3]) });
    await scrape({ resultsWanted: 1 });
    expect(paths()).toEqual(['/sitemap.xml', '/offers?page=1', '/offers/1']);
  }, 10_000);

  it('C2 control: S1 without the manifest and the client floor runs faster than 1 s apart', async () => {
    env({ EVER_JOBS_CRAWL_PLUGIN_MANIFESTS: 'false', SOFTY_LEGACY: 'no-interval-floor' });
    delayMs = 700;
    healthyTenant([1, 2, 3]);
    await scrape({ resultsWanted: 2 });
    expect(paths()).toEqual(['/sitemap.xml', '/offers/3', '/offers/2']);
    expect(Math.min(...startGaps())).toBeLessThan(975);
    expect(Math.min(...idleGaps())).toBeLessThan(475);
  }, 10_000);
});
