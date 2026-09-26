import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * Softy discovery against the REAL crawl-policy resolver (Spec 1690 layers), with
 * only the HTTP client faked: proves each configuration surface — caller `crawl`,
 * `EVER_JOBS_CRAWL_DISCOVERY`, operator `sites.softy` / `hosts["*.softy.pro"]`, and a
 * surrounding scrape context — actually selects the discovery mode.
 */

const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args) };
});

import { getScrapeContext, resetCrawlPolicyEnvCache, runWithScrapeContext } from '@ever-jobs/common';
import { SoftyService } from '../src/softy.service';
import { SOFTY_CRAWL_POLICY } from '../src/softy.constants';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = 'https://acme.softy.pro';
const SITEMAP = `${BASE}/sitemap.xml`;
const PAGE1 = `${BASE}/offers?page=1`;

const ENV_KEYS = ['EVER_JOBS_CRAWL_DISCOVERY', 'EVER_JOBS_CRAWL_POLICIES', 'EVER_JOBS_CRAWL_CALLER_OVERRIDES'];

describe('SoftyService discovery through the real crawl policy (Spec 1690/1691)', () => {
  const saved: Record<string, string | undefined> = {};
  let calls: string[];
  let contextsSeen: unknown[];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetCrawlPolicyEnvCache();
    calls = [];
    contextsSeen = [];
    const routes: Record<string, string> = {
      [SITEMAP]: fixture('sitemap.xml'),
      [PAGE1]: fixture('listing-page-1.html'),
    };
    mockCreateHttpClient.mockReset().mockImplementation(() => ({
      setHeaders: jest.fn(),
      post: jest.fn(),
      get: jest.fn(async (url: string, config?: any) => {
        calls.push(url);
        contextsSeen.push(getScrapeContext());
        const body = routes[url];
        if (body === undefined) {
          throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
        }
        return { data: config?.responseType === 'arraybuffer' ? Buffer.from(body) : body, status: 200 };
      }),
    }));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetCrawlPolicyEnvCache();
  });

  const scrape = (extra: Record<string, unknown> = {}) =>
    new SoftyService().scrape(
      new ScraperInputDto({
        siteType: [Site.SOFTY],
        companySlug: 'acme',
        resultsWanted: 1,
        descriptionFormat: DescriptionFormat.PLAIN,
        ...extra,
      } as Partial<ScraperInputDto>),
    );

  it('defaults to auto → sitemap first', async () => {
    await scrape();
    expect(calls[0]).toBe(SITEMAP);
  });

  it('honours the caller crawl.discovery', async () => {
    await scrape({ crawl: { discovery: 'listing' } });
    expect(calls[0]).toBe(PAGE1);
  });

  it('honours EVER_JOBS_CRAWL_DISCOVERY', async () => {
    process.env.EVER_JOBS_CRAWL_DISCOVERY = 'listing';
    resetCrawlPolicyEnvCache();
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it('honours an operator sites.softy policy', async () => {
    process.env.EVER_JOBS_CRAWL_POLICIES = JSON.stringify({ sites: { softy: { discovery: 'listing' } } });
    resetCrawlPolicyEnvCache();
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it('honours an operator hosts["*.softy.pro"] policy', async () => {
    process.env.EVER_JOBS_CRAWL_POLICIES = JSON.stringify({ hosts: { '*.softy.pro': { discovery: 'listing' } } });
    resetCrawlPolicyEnvCache();
    await scrape();
    expect(calls[0]).toBe(PAGE1);
  });

  it('the caller beats the operator outside a scrape context', async () => {
    process.env.EVER_JOBS_CRAWL_POLICIES = JSON.stringify({ sites: { softy: { discovery: 'listing' } } });
    resetCrawlPolicyEnvCache();
    await scrape({ crawl: { discovery: 'sitemap' } });
    expect(calls[0]).toBe(SITEMAP);
  });

  it('runs its requests inside a scrape context carrying the plugin policy when called directly', async () => {
    await scrape({ crawl: { discovery: 'listing' } });
    expect(contextsSeen[0]).toMatchObject({ site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' } });
  });

  it("inside JobsService's scrape context, the context decides and is not replaced", async () => {
    const ctx = { site: Site.SOFTY, plugin: SOFTY_CRAWL_POLICY, caller: { discovery: 'listing' as const } };
    await runWithScrapeContext(ctx, () => scrape({ crawl: { discovery: 'sitemap' } }));
    expect(calls[0]).toBe(PAGE1);
    expect(contextsSeen[0]).toMatchObject(ctx);
  });
});
