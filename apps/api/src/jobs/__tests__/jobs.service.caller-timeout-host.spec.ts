import 'reflect-metadata';
import axios, { AxiosHeaders, CreateAxiosDefaults, InternalAxiosRequestConfig } from 'axios';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import {
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resetHostLimiter,
} from '@ever-jobs/common';
import { JsonLdService } from '@ever-jobs/source-jsonld';
import { JobsService } from '../jobs.service';

/**
 * Spec 1715 audit C0, end to end through `JobsService` and the REAL `HttpClient`
 * (only the axios adapter is replaced): `jsonld` has no lock, so its site-level
 * caller mode is `any` and a caller's `requestTimeout` reaches its client
 * unchanged. Pointed at a Softy page, the request resolves to the builtin
 * `*.softy.pro` host policy (`stricter`), which must gate the caller's timeout
 * again for that HOST: a tiny timeout becomes the 60 s default instead of going
 * on the wire (where the client-side abort used to cool all of softy.pro for 30 s).
 */

const realCreate = axios.create.bind(axios);
const timeouts: Array<{ url: string; timeout: number | undefined }> = [];

function createService(): JobsService {
  const scraper = new JsonLdService();
  const service: any = Object.create(JobsService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  service.registry = {
    size: 1,
    siteForDomain: () => undefined,
    getScraper: (s: Site) => (s === Site.JSONLD ? scraper : undefined),
    listSiteKeys: () => [Site.JSONLD],
    listAtsSites: () => [],
    listSources: () => [],
    getMetadata: (s: Site) => ({ site: s, name: String(s), category: 'job-board' }),
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') return { defaultRetries: 0, defaultDelayMs: 1, defaultBackoff: 'linear', perSource: {} };
      if (key === 'search.concurrency') return 4;
      if (key === 'search.deadlineMs') return 0;
      return def;
    },
  };
  service.metrics = { scraperDuration: { startTimer: () => () => undefined }, scraperRequestsTotal: { inc: jest.fn() } };
  service.circuitBreaker = undefined;
  return service as JobsService;
}

const ENV_KEYS = [...Object.values(CRAWL_ENV), ...Object.values(CRAWL_EXTRA_ENV)];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
  timeouts.length = 0;
  jest.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults) => {
    const instance = realCreate(config);
    instance.defaults.adapter = async (cfg: InternalAxiosRequestConfig) => {
      const url = String(cfg.url);
      if (!url.endsWith('/robots.txt')) timeouts.push({ url, timeout: cfg.timeout });
      const data = url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n' : '<html><head><title>x</title></head><body></body></html>';
      return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: cfg, request: {} };
    };
    return instance;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
});

async function search(companyUrl: string, requestTimeout?: number): Promise<number | undefined> {
  await createService().searchJobs(
    new ScraperInputDto({ siteType: [Site.JSONLD], companyUrl, ...(requestTimeout !== undefined ? { requestTimeout } : {}) }),
  );
  const page = timeouts.filter((t) => t.url === companyUrl);
  expect(page).toHaveLength(1); // the instrument saw the page request
  return page[0].timeout;
}

describe('a caller requestTimeout is gated per request HOST (Spec 1715 audit C0)', () => {
  it('jsonld → a *.softy.pro page: a 1 ms caller timeout becomes the 60 s default', async () => {
    expect(await search('https://acme.softy.pro/offers/1', 0.001)).toBe(60_000);
  });

  it('jsonld → a *.softy.pro page: a longer caller timeout (stricter) is kept', async () => {
    expect(await search('https://acme.softy.pro/offers/1', 120)).toBe(120_000);
  });

  it('control: jsonld → an unlocked host keeps the caller timeout unchanged (byte-identical)', async () => {
    expect(await search('https://careers.example.com/jobs/1', 0.001)).toBe(1);
  });

  it('control: no caller timeout → the DTO default 60 s, unchanged on either host', async () => {
    expect(await search('https://acme.softy.pro/offers/1')).toBe(60_000);
    expect(await search('https://careers.example.com/jobs/2')).toBe(60_000);
  });

  it('EVER_JOBS_CRAWL_STRICTER_RULES=1690 restores the ungated timeout (pre-fix)', async () => {
    process.env.EVER_JOBS_CRAWL_STRICTER_RULES = '1690';
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    expect(await search('https://acme.softy.pro/offers/1', 0.001)).toBe(1);
  });
});
