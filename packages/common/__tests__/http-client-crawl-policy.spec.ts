import 'reflect-metadata';
import type * as dns from 'dns';
import axios, { AxiosError, AxiosHeaders, CanceledError, InternalAxiosRequestConfig } from 'axios';
import { MAX_CRAWL_RETRIES, ScraperInputDto, classifyScrapeError } from '@ever-jobs/models';

import {
  HttpClient,
  MIN_RETRY_DELAY_MS,
  crawlAcquireOptions,
  createHttpClient,
  crawlOverrideFromClientOptions,
  isRetryableNetworkError,
  parseRetryAfter,
  penalizesBucket,
  recordAnswerOutcome,
  retryBackoffMs,
  retryDecision,
  selectWireUserAgent,
  throttleRetryFloorMs,
} from '../src/http/http-client';
import { resetProxyScrapeSeed } from '../src/http/crawl/proxy-selector';
import {
  CRAWL_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  LEGACY_BROWSER_USER_AGENT,
  LEGACY_CRAWL_POLICY,
  POLITE_CRAWL_POLICY,
  STRICT_CRAWL_POLICY,
} from '../src/http/crawl/defaults';
import { getGuardedAgents, resetGuardedAgents, EGRESS_GUARD_ENV } from '../src/http/crawl/egress-guard';
import { CRAWL_EXTRA_ENV, resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { CrawlQueueTimeoutError, EgressBlockedError, HostCoolingDownError, RobotsDisallowedError } from '../src/http/crawl/errors';
import { HostLimiter, getHostLimiter, resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetRobotsTxtCache } from '../src/http/crawl/robots';
import { resetEffectiveCrawlPolicyCache, runWithScrapeContext } from '../src/http/crawl/scrape-context';
import { CrawlPolicy, ScrapeContext } from '../src/http/crawl/types';

/**
 * Spec 1690 §4.2–§4.9 — `HttpClient` under the crawl policy. Requests go through
 * the REAL axios pipeline (defaults merge, header flattening, interceptors) into
 * a fake adapter, so the header precedence tested here is axios' own. No network.
 */

// ── harness ──────────────────────────────────────────────────────────────────

type Reply =
  | { status: number; data?: unknown; headers?: Record<string, string>; delayMs?: number; hang?: boolean }
  | Error;

interface Sent {
  url: string;
  method: string;
  startedAt: number;
  config: InternalAxiosRequestConfig;
  header(name: string): string | undefined;
  headerNames(): string[];
}

interface Harness {
  sent: Sent[];
  maxInFlight(): number;
  inFlight(): number;
}

function wait(ms: number, signal?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = signal as AbortSignal | undefined;
    const timer = setTimeout(resolve, ms);
    s?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new CanceledError());
    });
  });
}

function hang(signal?: unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    const s = signal as AbortSignal | undefined;
    if (s?.aborted) reject(new CanceledError());
    s?.addEventListener?.('abort', () => reject(new CanceledError()));
  });
}

/** Route `client`'s axios instance to a fake adapter answering with `respond`. */
function attach(client: HttpClient, respond: (config: InternalAxiosRequestConfig, index: number) => Reply = () => ({ status: 200 })): Harness {
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  client.getAxiosInstance().defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const headers = config.headers as AxiosHeaders;
    const index = sent.length;
    sent.push({
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      startedAt: Date.now(),
      config,
      header: (name) => {
        const value = headers.get(name);
        return value === undefined || value === null || value === false ? undefined : String(value);
      },
      headerNames: () => Object.keys(headers.toJSON()),
    });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const reply = respond(config, index);
      if (reply instanceof Error) throw reply;
      if (reply.hang) await hang(config.signal);
      if (reply.delayMs) await wait(reply.delayMs, config.signal);
      const response = {
        data: reply.data ?? '',
        status: reply.status,
        statusText: String(reply.status),
        headers: new AxiosHeaders(reply.headers ?? {}),
        config,
        request: {},
      };
      const ok = config.validateStatus ? config.validateStatus(reply.status) : reply.status >= 200 && reply.status < 300;
      if (ok) return response;
      throw new AxiosError(
        `Request failed with status code ${reply.status}`,
        reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
        config,
        {},
        response,
      );
    } finally {
      inFlight--;
    }
  };
  return { sent, maxInFlight: () => maxInFlight, inFlight: () => inFlight };
}

const touchedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCrawlState();
}

function restoreEnv(): void {
  for (const [name, value] of touchedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touchedEnv.clear();
}

function resetCrawlState(): void {
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
  resetRobotsTxtCache();
}

/** Every crawl env var this suite may read, cleared so the host environment cannot leak in. */
const CLEARED_ENV = [
  ...Object.values(CRAWL_ENV),
  ...Object.values(CRAWL_EXTRA_ENV),
  EGRESS_GUARD_ENV.ALLOW_HOSTS,
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

async function settle<T>(promise: Promise<T>, ms = 60_000): Promise<T | Error> {
  const settled = promise.catch((err: Error) => err);
  await jest.advanceTimersByTimeAsync(ms);
  return settled;
}

function inScrape<T>(ctx: ScrapeContext, fn: () => T): T {
  return runWithScrapeContext(ctx, fn);
}

function gaps(sent: Sent[]): number[] {
  const starts = sent.map((s) => s.startedAt).sort((a, b) => a - b);
  return starts.slice(1).map((t, i) => t - starts[i]);
}

const URL_A = 'https://acme.example.com/jobs';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  setEnv(Object.fromEntries(CLEARED_ENV.map((name) => [name, undefined])));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  restoreEnv();
  resetCrawlState();
});

afterAll(() => resetGuardedAgents());

// ── identity ─────────────────────────────────────────────────────────────────

describe('identity — the User-Agent table (Spec 1690 §4.2)', () => {
  it('sends the honest Ever Jobs UA by default', async () => {
    const client = new HttpClient();
    const h = attach(client);

    await settle(client.get(URL_A));

    expect(h.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('identify: a UA declared through setHeaders (any case) stays off the wire; the other headers go out', async () => {
    const client = new HttpClient();
    client.setHeaders({ 'user-agent': 'Chrome/129 spoof', 'Accept-Language': 'fr-FR' });
    const h = attach(client);

    await settle(client.get(URL_A));

    expect(h.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    expect(h.sent[0].header('Accept-Language')).toBe('fr-FR');
    expect(h.sent[0].headerNames().filter((n) => n.toLowerCase() === 'user-agent')).toHaveLength(1);
  });

  it('identify: a per-request UA header is replaced too', async () => {
    const client = new HttpClient();
    const h = attach(client);

    await settle(client.get(URL_A, { headers: { 'User-Agent': 'PerRequest/1' } }));

    expect(h.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  describe('a plugin opt-in (manifest userAgentMode: plugin)', () => {
    const plugin = { userAgentMode: 'plugin' as const, userAgentReason: 'API requires a registered e-mail UA' };

    it('lets the declared UA through: per-request > setHeaders > option > configured', async () => {
      const client = new HttpClient({ userAgent: 'Option/1' });
      client.setHeaders({ 'User-Agent': 'ops@example.gov' });
      const h = attach(client);

      await inScrape({ site: 'usajobs', plugin }, () =>
        settle(Promise.all([client.get(URL_A, { headers: { 'user-agent': 'PerRequest/1' } }), client.get(URL_A)])),
      );
      const bare = new HttpClient();
      const hb = attach(bare);
      await inScrape({ site: 'usajobs', plugin }, () => settle(bare.get(URL_A)));
      const optionOnly = new HttpClient({ userAgent: 'Option/1' });
      const ho = attach(optionOnly);
      await inScrape({ site: 'usajobs', plugin }, () => settle(optionOnly.get(URL_A)));

      expect(h.sent.map((s) => s.header('User-Agent')).sort()).toEqual(['PerRequest/1', 'ops@example.gov']);
      expect(hb.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(ho.sent[0].header('User-Agent')).toBe('Option/1');
    });

    it('is still honoured when an operator host policy sets identify (the identify row of the table)', async () => {
      setEnv({ [CRAWL_ENV.POLICIES]: JSON.stringify({ hosts: { 'acme.example.com': { userAgentMode: 'identify' } } }) });
      const client = new HttpClient();
      client.setHeaders({ 'User-Agent': 'ops@example.gov' });
      const h = attach(client);

      await inScrape({ site: 'usajobs', plugin }, () => settle(client.get(URL_A)));

      expect(client.crawlPolicyFor(URL_A).userAgentMode).toBe('identify');
      expect(h.sent[0].header('User-Agent')).toBe('ops@example.gov');
    });

    it('is overruled by strict (env): the configured UA always', async () => {
      setEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'strict' });
      const client = new HttpClient();
      client.setHeaders({ 'User-Agent': 'ops@example.gov' });
      const h = attach(client);

      await inScrape({ site: 'usajobs', plugin }, () => settle(client.get(URL_A, { headers: { 'User-Agent': 'Per/1' } })));

      expect(h.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });
  });

  it('plugin mode (env): whatever the plugin declared, else the configured UA', async () => {
    setEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });
    const declared = new HttpClient();
    declared.setHeaders({ 'User-Agent': 'Declared/2' });
    const hd = attach(declared);
    const silent = new HttpClient();
    const hs = attach(silent);

    await settle(Promise.all([declared.get(URL_A), silent.get(URL_A)]));

    expect(hd.sent[0].header('User-Agent')).toBe('Declared/2');
    expect(hs.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  describe('the userAgent option is a DECLARED UA (Spec 1690 §4.2), never the configured one', () => {
    const SPOOF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36';

    it('identify (default): the Ever Jobs UA goes out, inside a scrape context and outside one', async () => {
      const client = new HttpClient({ userAgent: SPOOF, retries: 0 } as never);
      const h = attach(client);

      await settle(client.get(URL_A));
      await inScrape({ site: 'liveness-http' }, () => settle(client.get(URL_A)));

      expect(h.sent.map((s) => s.header('User-Agent'))).toEqual([EVER_JOBS_DEFAULT_USER_AGENT, EVER_JOBS_DEFAULT_USER_AGENT]);
      expect(client.crawlPolicyFor(URL_A).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('strict + an env UA: the env UA goes out, the option cannot replace it', async () => {
      setEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'strict', [CRAWL_ENV.USER_AGENT]: 'OpsBot/1.0 (ops@x.example)' });
      const client = new HttpClient({ userAgent: 'Mozilla/5.0 (compatible; StapplyMap/1.0)' });
      const h = attach(client);

      await settle(client.get(URL_A));

      expect(h.sent[0].header('User-Agent')).toBe('OpsBot/1.0 (ops@x.example)');
    });

    it('a manifest / client crawl.userAgent is declared too: not sent under identify, sent with the opt-in', async () => {
      const declaredOnly = new HttpClient({ crawl: { userAgent: 'CrawlOpt/1' } });
      const hd = attach(declaredOnly);
      await inScrape({ site: 'x', plugin: { userAgent: 'Manifest/1' } }, () => settle(declaredOnly.get(URL_A)));

      const optedIn = new HttpClient();
      const ho = attach(optedIn);
      await inScrape({ site: 'x', plugin: { userAgent: 'Manifest/1', userAgentMode: 'plugin', userAgentReason: 'r' } }, () =>
        settle(optedIn.get(URL_A)),
      );

      expect(hd.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(ho.sent[0].header('User-Agent')).toBe('Manifest/1');
    });

    it('plugin mode: the option goes out; an operator host UA becomes the fallback only', async () => {
      setEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });
      const client = new HttpClient({ userAgent: 'LivenessBot/1' });
      const h = attach(client);

      await settle(client.get(URL_A));

      expect(h.sent[0].header('User-Agent')).toBe('LivenessBot/1');
    });

    it('legacy preset: the option is the client default UA again (per-request header > option > configured)', async () => {
      setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
      const client = new HttpClient({ userAgent: 'LivenessBot/1' });
      client.setHeaders({ 'User-Agent': 'SetHeaders/1' });
      const h = attach(client);

      await settle(client.get(URL_A));
      await settle(client.get(URL_A, { headers: { 'User-Agent': 'Per/1' } }));
      const bare = new HttpClient();
      const hb = attach(bare);
      await settle(bare.get(URL_A));

      expect(h.sent.map((s) => s.header('User-Agent'))).toEqual(['LivenessBot/1', 'Per/1']);
      expect(hb.sent[0].header('User-Agent')).toBe(LEGACY_BROWSER_USER_AGENT);
    });

    it('crawlOverrideFromClientOptions leaves the userAgent option out of the policy layer', () => {
      expect(crawlOverrideFromClientOptions({ userAgent: 'X/1', retries: 1 })).toEqual({ retries: 1 });
    });
  });

  it('a caller UA (search request) goes out as sent, over any declaration', async () => {
    const client = new HttpClient();
    client.setHeaders({ 'User-Agent': 'Declared/3' });
    const h = attach(client);

    await inScrape({ site: 'x', caller: { userAgent: 'CallerBot/1' }, plugin: { userAgentMode: 'plugin', userAgentReason: 'r' } }, () =>
      settle(client.get(URL_A, { headers: { 'User-Agent': 'Per/1' } })),
    );

    expect(h.sent[0].header('User-Agent')).toBe('CallerBot/1');
  });

  it('EVER_JOBS_CRAWL_CONTACT goes into the default UA; EVER_JOBS_CRAWL_USER_AGENT=browser is the pre-1690 string', async () => {
    setEnv({ [CRAWL_ENV.CONTACT]: 'ops@acme.example' });
    const a = new HttpClient();
    const ha = attach(a);
    await settle(a.get(URL_A));

    setEnv({ [CRAWL_ENV.CONTACT]: undefined, [CRAWL_ENV.USER_AGENT]: 'browser' });
    const b = new HttpClient();
    const hb = attach(b);
    await settle(b.get(URL_A));

    expect(ha.sent[0].header('User-Agent')).toContain('EverJobs/1.0');
    expect(ha.sent[0].header('User-Agent')).toContain('ops@acme.example');
    expect(hb.sent[0].header('User-Agent')).toBe(LEGACY_BROWSER_USER_AGENT);
  });

  it('also governs calls made straight through getAxiosInstance()', async () => {
    const client = new HttpClient();
    const h = attach(client);

    await settle(client.getAxiosInstance().get(URL_A, { headers: { 'User-Agent': 'Raw/1' } }));

    expect(h.sent[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('a per-request crawl override applies to that request only', async () => {
    const client = new HttpClient();
    client.setHeaders({ 'User-Agent': 'Declared/4' });
    const h = attach(client);
    const config: import('../src/http/http-client').CrawlRequestConfig = { crawl: { userAgentMode: 'plugin' } };

    await settle(Promise.all([client.get(URL_A, config), client.get(URL_A)]));

    expect(h.sent.map((s) => s.header('User-Agent')).sort()).toEqual(['Declared/4', EVER_JOBS_DEFAULT_USER_AGENT].sort());
  });
});

describe('client hints and From (Spec 1690 §4.2)', () => {
  const hints = { 'sec-ch-ua': '"Chromium";v="120"', 'sec-ch-ua-mobile': '?0', 'Sec-Fetch-Mode': 'navigate' };

  it('strips every sec-ch-ua* header when the configured UA is sent, keeps sec-fetch-*', async () => {
    const client = new HttpClient();
    client.setHeaders(hints);
    const h = attach(client);

    await settle(client.get(URL_A, { headers: { 'Sec-CH-UA-Platform': '"macOS"' } }));

    const names = h.sent[0].headerNames().map((n) => n.toLowerCase());
    expect(names.filter((n) => n.startsWith('sec-ch-ua'))).toEqual([]);
    expect(h.sent[0].header('Sec-Fetch-Mode')).toBe('navigate');
  });

  it('keeps them when the plugin-declared UA is what goes out', async () => {
    setEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });
    const client = new HttpClient();
    client.setHeaders({ ...hints, 'User-Agent': 'Chrome/120 declared' });
    const h = attach(client);

    await settle(client.get(URL_A));

    expect(h.sent[0].header('sec-ch-ua')).toBe('"Chromium";v="120"');
    expect(h.sent[0].header('sec-ch-ua-mobile')).toBe('?0');
  });

  it('keeps them when EVER_JOBS_CRAWL_STRIP_CLIENT_HINTS=false', async () => {
    setEnv({ [CRAWL_ENV.STRIP_CLIENT_HINTS]: 'false' });
    const client = new HttpClient();
    client.setHeaders(hints);
    const h = attach(client);

    await settle(client.get(URL_A));

    expect(h.sent[0].header('sec-ch-ua')).toBe('"Chromium";v="120"');
  });

  it('adds From when EVER_JOBS_CRAWL_FROM is set, and nothing otherwise', async () => {
    const plain = new HttpClient();
    const hp = attach(plain);
    await settle(plain.get(URL_A));

    setEnv({ [CRAWL_ENV.FROM]: 'crawler@acme.example' });
    const withFrom = new HttpClient();
    const hf = attach(withFrom);
    await settle(withFrom.get(URL_A));

    expect(hp.sent[0].header('From')).toBeUndefined();
    expect(hf.sent[0].header('From')).toBe('crawler@acme.example');
  });
});

// ── legacy preset ────────────────────────────────────────────────────────────

describe('EVER_JOBS_CRAWL_PRESET=legacy reproduces the pre-1690 wire behaviour', () => {
  beforeEach(() => setEnv({ [CRAWL_ENV.PRESET]: 'legacy' }));

  it('UA: Chrome/120 even when setHeaders declared another; a per-request header or the userAgent option still win', async () => {
    const declared = new HttpClient();
    declared.setHeaders({ 'User-Agent': 'Chrome/129 declared', 'Accept-Language': 'fr' });
    const hd = attach(declared);
    const option = new HttpClient({ userAgent: 'Option/1' });
    const ho = attach(option);

    await settle(Promise.all([declared.get(URL_A), declared.get(URL_A, { headers: { 'User-Agent': 'Per/1' } }), option.get(URL_A)]));

    expect(hd.sent.map((s) => s.header('User-Agent'))).toEqual([LEGACY_BROWSER_USER_AGENT, 'Per/1']);
    expect(hd.sent[0].header('Accept-Language')).toBe('fr');
    expect(ho.sent[0].header('User-Agent')).toBe('Option/1');
  });

  it('rotates proxies per request, round-robin from the first', async () => {
    const client = new HttpClient({ proxies: ['http://p1.example:8080', 'http://p2.example:8080', 'localhost'] });
    const h = attach(client);

    for (let i = 0; i < 4; i++) await settle(client.get(URL_A));

    const via = h.sent.map((s) => (s.config.httpsAgent as { proxy?: URL } | undefined)?.proxy?.host ?? 'direct');
    expect(via).toEqual(['p1.example:8080', 'p2.example:8080', 'direct', 'p1.example:8080']);
  });

  it('retries 3 times, linearly, on 500 too — and caps a long Retry-After at 30 s instead of giving up', async () => {
    const client = new HttpClient();
    const warn = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '120' } } : i < 3 ? { status: 500 } : { status: 200 }));

    const result = await settle(client.get(URL_A), 120_000);

    expect(result).not.toBeInstanceOf(Error);
    expect(h.sent).toHaveLength(4);
    expect(warn.mock.calls.map((c) => /in (\d+)ms/.exec(c[0] as string)?.[1])).toEqual(['30000', '2000', '3000']);
  });

  it('neither paces nor guards egress: 10 parallel requests to 127.0.0.1 all start at once, with the old agents', async () => {
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 200, delayMs: 500 }));

    await settle(Promise.all(Array.from({ length: 10 }, (_, i) => client.get(`http://127.0.0.1:9/item/${i}`))));

    expect(h.sent).toHaveLength(10);
    expect(new Set(h.sent.map((s) => s.startedAt)).size).toBe(1);
    expect(h.sent[0].config.httpAgent).toBeUndefined();
    expect(h.sent[0].config.beforeRedirect).toBeUndefined();
  });

  it('does not penalise the bucket on a 429 (no whole-bucket back-off before 1690)', async () => {
    const client = new HttpClient({ retries: 0 });
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '20' } } : { status: 200 }));

    await settle(client.get(URL_A), 0);
    await settle(client.get(URL_A), 0);

    expect(h.sent.map((s) => s.startedAt)).toEqual([h.sent[0].startedAt, h.sent[0].startedAt]);
  });

  it('applies neither builtin host limits nor plugin manifests: bulk ATS hosts and Softy stay unpaced', async () => {
    const softy = { rateLimitScope: 'domain' as const, maxConcurrentPerHost: 1, minIntervalMs: 1000 };
    const client = new HttpClient();

    const greenhouse = client.crawlPolicyFor('https://boards-api.greenhouse.io/v1/boards/x/jobs');
    const lever = client.crawlPolicyFor('https://api.lever.co/v0/postings/x');
    const tenant = inScrape({ site: 'softy', plugin: softy }, () => client.crawlPolicyFor('https://acme.softy.pro/offers'));

    for (const policy of [greenhouse, lever, tenant]) {
      expect(policy.maxConcurrentPerHost).toBe(0);
      expect(policy.minIntervalMs).toBe(0);
      expect(policy.rateLimitScope).toBe('host');
    }
  });

  it('...each of which can be switched back on (EVER_JOBS_CRAWL_BUILTIN_HOSTS / _PLUGIN_MANIFESTS)', async () => {
    setEnv({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'true', [CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS]: 'on' });
    const client = new HttpClient();

    expect(client.crawlPolicyFor('https://boards-api.greenhouse.io/x').maxConcurrentPerHost).toBe(16);
    expect(
      inScrape({ site: 'softy', plugin: { maxConcurrentPerHost: 1 } }, () => client.crawlPolicyFor('https://acme.softy.pro/')).maxConcurrentPerHost,
    ).toBe(1);
  });

  it('ignores DEFAULT_PROXIES (pre-1690 parsed it and never used it); EVER_JOBS_CRAWL_PROXIES still applies', async () => {
    setEnv({ [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy.example:3128' });
    const direct = new HttpClient();
    const hd = attach(direct);
    await settle(direct.get(URL_A));

    setEnv({ [CRAWL_ENV.PROXIES]: 'http://env.example:3128' });
    const viaEnv = new HttpClient();
    const he = attach(viaEnv);
    await settle(viaEnv.get(URL_A));

    expect((hd.sent[0].config.httpsAgent as { proxy?: URL } | undefined)?.proxy).toBeUndefined();
    expect((he.sent[0].config.httpsAgent as unknown as { proxy: URL }).proxy.host).toBe('env.example:3128');
  });
});

// ── pacing ───────────────────────────────────────────────────────────────────

describe('pacing through the host limiter (Spec 1690 §4.3)', () => {
  it('a 100-request Promise.allSettled fan-out never exceeds maxConcurrentPerHost and respects minIntervalMs', async () => {
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 200, delayMs: 1000 }));

    const results = await settle(
      Promise.allSettled(Array.from({ length: 100 }, (_, i) => client.get(`${URL_A}/${i}`))),
      120_000,
    );

    expect((results as PromiseSettledResult<unknown>[]).every((r) => r.status === 'fulfilled')).toBe(true);
    expect(h.sent).toHaveLength(100);
    expect(h.maxInFlight()).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
    expect(Math.min(...gaps(h.sent))).toBeGreaterThanOrEqual(POLITE_CRAWL_POLICY.minIntervalMs);
  });

  it('an operator host policy (Softy-style: 1 in flight, 1 s apart) bounds a burst', async () => {
    setEnv({
      [CRAWL_ENV.POLICIES]: JSON.stringify({ hosts: { '*.softy.pro': { maxConcurrentPerHost: 1, minIntervalMs: 1000 } } }),
    });
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 200, delayMs: 200 }));

    await settle(Promise.allSettled(Array.from({ length: 10 }, (_, i) => client.get(`https://acme.softy.pro/offre/${i}`))));

    expect(h.maxInFlight()).toBe(1);
    expect(Math.min(...gaps(h.sent))).toBeGreaterThanOrEqual(1000);
  });

  it('domain scope makes every tenant of one platform share a budget', async () => {
    const plugin = { rateLimitScope: 'domain' as const, maxConcurrentPerHost: 1, minIntervalMs: 1000 };
    const client = new HttpClient();
    const h = attach(client);

    await inScrape({ site: 'softy', plugin }, () =>
      settle(Promise.all(['a', 'b', 'c', 'd'].map((t) => client.get(`https://${t}.softy.pro/offres`)))),
    );

    expect(new Set(h.sent.map((s) => new URL(s.url).host)).size).toBe(4);
    expect(Math.min(...gaps(h.sent))).toBeGreaterThanOrEqual(1000);
  });

  it('rateDelayMin/Max space concurrent calls instead of one gap then a burst', async () => {
    const client = new HttpClient({ rateDelayMin: 2, rateDelayMax: 3 });
    const h = attach(client);

    await settle(Promise.all(Array.from({ length: 5 }, () => client.get(URL_A))));

    const g = gaps(h.sent);
    expect(Math.min(...g)).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...g)).toBeLessThanOrEqual(3000);
  });

  describe('minIntervalFloorMs — a spacing floor no policy layer shortens', () => {
    const caller = { minIntervalMs: 50, jitterMs: 0 };

    it('a caller rateDelayMin replaces the plugin-layer rateDelayMin, but not the floor', async () => {
      const paced = new HttpClient({ rateDelayMin: 1, rateDelayMax: 1 });
      const floored = new HttpClient({ rateDelayMin: 1, rateDelayMax: 1, minIntervalFloorMs: 1000 });
      const hp = attach(paced);
      const hf = attach(floored);

      await inScrape({ site: 'remoteok', caller }, () =>
        settle(
          Promise.all([
            paced.get(URL_A),
            paced.get(URL_A),
            floored.get('https://floored.example.org/api'),
            floored.get('https://floored.example.org/api'),
          ]),
          10_000,
        ),
      );

      // Control: the caller layer wins over the client's rateDelayMin (Spec 1690 §4.1)…
      expect(gaps(hp.sent)[0]).toBeLessThan(1000);
      // …while the floor holds.
      expect(gaps(hf.sent)[0]).toBeGreaterThanOrEqual(1000);
    });

    it('bounds an operator policy and the legacy preset too, and is copied from an input-shaped object', async () => {
      setEnv({
        [CRAWL_ENV.PRESET]: 'legacy',
        [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { remoteok: { minIntervalMs: 10 } } }),
      });
      const client = createHttpClient({ requestTimeout: 10, proxies: [], minIntervalFloorMs: 1500 });
      const h = attach(client);

      await inScrape({ site: 'remoteok', caller }, () => settle(Promise.all([client.get(URL_A), client.get(URL_A)]), 10_000));

      expect(gaps(h.sent)[0]).toBeGreaterThanOrEqual(1500);
    });

    it('ignores a non-positive or non-finite floor', async () => {
      const client = new HttpClient({ minIntervalFloorMs: Number.NaN });
      const acquire = jest.spyOn(getHostLimiter(), 'acquire');
      attach(client);

      await inScrape({ site: 'remoteok', caller }, () => settle(client.get(URL_A)));

      expect(acquire).toHaveBeenCalledWith('host:acme.example.com', expect.objectContaining({ minIntervalMs: 50 }));
    });
  });

  it('different hosts do not wait for each other; clients share one host budget', async () => {
    setEnv({ [CRAWL_ENV.MIN_INTERVAL_MS]: '5000' });
    const one = new HttpClient();
    const two = new HttpClient();
    const h1 = attach(one);
    const h2 = attach(two);

    await settle(Promise.all([one.get(URL_A), one.get('https://other.example.org/x'), two.get(URL_A)]), 10_000);

    const t0 = h1.sent[0].startedAt;
    expect(h1.sent.map((s) => s.startedAt - t0)).toEqual([0, 0]);
    expect(h2.sent[0].startedAt - t0).toBeGreaterThanOrEqual(5000);
  });

  it('uses an injected limiter instead of the process-wide one', async () => {
    const limiter = new HostLimiter();
    const client = new HttpClient({ hostLimiter: limiter });
    const acquire = jest.spyOn(limiter, 'acquire');
    attach(client);

    await settle(client.get(URL_A));

    expect(acquire).toHaveBeenCalledWith('host:acme.example.com', expect.objectContaining({ maxConcurrent: 4 }));
  });

  it('a queue wait over maxQueueWaitMs fails with CrawlQueueTimeoutError', async () => {
    setEnv({ [CRAWL_ENV.MAX_CONCURRENT_PER_HOST]: '1', [CRAWL_ENV.MAX_QUEUE_WAIT_MS]: '500' });
    const client = new HttpClient();
    attach(client, () => ({ status: 200, delayMs: 2000 }));

    const [first, second] = await settle(
      Promise.allSettled([client.get(URL_A), client.get(URL_A)]),
      5000,
    ) as PromiseSettledResult<unknown>[];

    expect(first.status).toBe('fulfilled');
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(CrawlQueueTimeoutError);
  });
});

// ── retries ──────────────────────────────────────────────────────────────────

describe('retries and back-off (Spec 1690 §4.5)', () => {
  it('retries the polite statuses (429/502/503/504) but not 500 or 404', async () => {
    const client = new HttpClient({ crawl: { retryJitter: false } });
    const h = attach(client, (c) => {
      const code = Number(String(c.url).split('/').pop());
      return { status: code };
    });

    const results = await settle(Promise.allSettled([429, 502, 503, 504, 500, 404].map((s) => client.get(`https://s${s}.example.com/${s}`))));

    const count = (s: number) => h.sent.filter((x) => x.url.endsWith(`/${s}`)).length;
    expect((results as PromiseSettledResult<unknown>[]).every((r) => r.status === 'rejected')).toBe(true);
    expect([429, 502, 503, 504, 500, 404].map(count)).toEqual([3, 3, 3, 3, 1, 1]);
  });

  it('backs off exponentially from retryBaseDelayMs (no jitter)', async () => {
    const client = new HttpClient({ retries: 3, crawl: { retryJitter: false, adaptiveThrottle: false } });
    const h = attach(client, () => ({ status: 502 }));

    await settle(client.get(URL_A));

    expect(gaps(h.sent)).toEqual([1000, 2000, 4000]);
  });

  it('full jitter keeps each wait within 0..backoff', async () => {
    const client = new HttpClient({ retries: 3, crawl: { adaptiveThrottle: false } });
    const h = attach(client, () => ({ status: 502 }));

    await settle(client.get(URL_A));

    gaps(h.sent).forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(1000 * 2 ** i);
    });
  });

  it('honours Retry-After in delta-seconds — never earlier than asked', async () => {
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '7' } } : { status: 200 }));

    await settle(client.get(URL_A));

    expect(gaps(h.sent)[0]).toBeGreaterThanOrEqual(7000);
  });

  it('honours Retry-After as an HTTP-date', async () => {
    const client = new HttpClient();
    const h = attach(client, (_c, i) =>
      i === 0 ? { status: 503, headers: { 'retry-after': new Date(Date.now() + 9000).toUTCString() } } : { status: 200 },
    );

    await settle(client.get(URL_A));

    expect(gaps(h.sent)[0]).toBeGreaterThanOrEqual(8000);
    expect(gaps(h.sent)[0]).toBeLessThanOrEqual(10_000);
  });

  it('gives up on a Retry-After over maxRetryAfterMs: HostCoolingDownError, and the bucket cools down for all of it', async () => {
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '120' } } : { status: 200 }));

    const err = (await settle(client.get(URL_A), 0)) as HostCoolingDownError;

    expect(err).toBeInstanceOf(HostCoolingDownError);
    expect(err.code).toBe('ERR_CRAWL_HOST_COOLING_DOWN');
    expect(err.bucket).toBe('host:acme.example.com');
    expect(err.retryAfterMs).toBe(120_000);
    expect(err.status).toBe(429);
    expect((err as Error & { cause?: AxiosError }).cause?.response?.status).toBe(429);
    expect(h.sent).toHaveLength(1);
    expect(getHostLimiter().coolingDownUntil('host:acme.example.com') - Date.now()).toBe(120_000);

    // The next request to the bucket does not wait longer than we ever wait for
    // the server (maxRetryAfterMs = 60 s): it fails fast instead of hanging for 120 s.
    const next = await settle(client.get(`${URL_A}/next`), 0);
    expect(next).toBeInstanceOf(HostCoolingDownError);
    expect(h.sent).toHaveLength(1);

    // Once the cool-down is within maxRetryAfterMs, a request queues and waits it out.
    await jest.advanceTimersByTimeAsync(61_000);
    const later = client.get(`${URL_A}/later`);
    await jest.advanceTimersByTimeAsync(58_000);
    expect(h.sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2_000);
    await later;
    expect(h.sent).toHaveLength(2);
  });

  it('gives up with HostCoolingDownError (not the raw 429) even with retries: 0 — diagnostic rate_limited', async () => {
    const client = new HttpClient({ retries: 0 });
    const h = attach(client, () => ({ status: 429, headers: { 'retry-after': '120' } }));

    const err = (await settle(client.get(URL_A), 0)) as HostCoolingDownError;

    expect(err).toBeInstanceOf(HostCoolingDownError);
    expect(err.retryAfterMs).toBe(120_000);
    expect(err.status).toBe(429);
    expect((err as Error & { cause?: AxiosError }).cause?.response?.status).toBe(429);
    expect(h.sent).toHaveLength(1);
    expect(getHostLimiter().coolingDownUntil('host:acme.example.com') - Date.now()).toBe(120_000);
    expect(classifyScrapeError(err).reason).toBe('rate_limited');
  });

  it('gives up with HostCoolingDownError on the last attempt too (retries used up)', async () => {
    const client = new HttpClient({ retries: 1, crawl: { retryJitter: false } });
    const h = attach(client, (_c, i) => (i === 0 ? { status: 503 } : { status: 503, headers: { 'retry-after': '600' } }));

    const err = await settle(client.get(URL_A));

    expect(err).toBeInstanceOf(HostCoolingDownError);
    expect((err as HostCoolingDownError).status).toBe(503);
    expect(h.sent).toHaveLength(2);
  });

  it('a 429 that is not retryable (retryStatuses none) still gives up with HostCoolingDownError over the max', async () => {
    const client = new HttpClient({ crawl: { retryStatuses: [] } });
    attach(client, () => ({ status: 429, headers: { 'retry-after': '120' } }));

    expect(await settle(client.get(URL_A), 0)).toBeInstanceOf(HostCoolingDownError);
  });

  it('a Retry-After on a non-retryable, non-throttling answer (404) still raises the raw error', async () => {
    const client = new HttpClient({ retries: 0 });
    attach(client, () => ({ status: 404, headers: { 'retry-after': '120' } }));

    const err = await settle(client.get(URL_A), 0);

    expect(err).toBeInstanceOf(AxiosError);
    expect(getHostLimiter().coolingDownUntil('host:acme.example.com')).toBe(0);
  });

  it(`retries: 10 with 0 ms delays waits at least MIN_RETRY_DELAY_MS (${MIN_RETRY_DELAY_MS} ms) per retry`, async () => {
    const client = new HttpClient({ retries: 10, retryDelay: 0, crawl: { retryJitter: false, minIntervalMs: 0, adaptiveThrottle: false } });
    const h = attach(client, () => ({ status: 502 }));

    await settle(client.get(URL_A));

    expect(h.sent).toHaveLength(11);
    expect(gaps(h.sent)).toEqual(Array(10).fill(MIN_RETRY_DELAY_MS));
  });

  it('retryMaxDelayMs: 0 is bounded the same way; a tiny base only until its back-off passes the minimum', async () => {
    const zeroCap = new HttpClient({ retries: 3, crawl: { retryMaxDelayMs: 0, minIntervalMs: 0, adaptiveThrottle: false } });
    const hz = attach(zeroCap, () => ({ status: 504 }));
    await settle(zeroCap.get(URL_A));
    expect(gaps(hz.sent)).toEqual([100, 100, 100]);

    const tiny = new HttpClient({
      retries: 9,
      crawl: { retryBaseDelayMs: 1, retryJitter: false, minIntervalMs: 0, adaptiveThrottle: false },
    });
    const ht = attach(tiny, () => ({ status: 502 }));
    await settle(tiny.get('https://tiny.example.com/'));
    expect(gaps(ht.sent)).toEqual([100, 100, 100, 100, 100, 100, 100, 128, 256]);
  });

  it('legacy: 0 ms delays retry immediately, as before 1690', async () => {
    setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
    const client = new HttpClient({ retries: 3, retryDelay: 0 });
    const h = attach(client, () => ({ status: 502 }));

    await settle(client.get(URL_A));

    // A 0 ms timer fires on the next 1 ms tick.
    expect(h.sent).toHaveLength(4);
    for (const gap of gaps(h.sent)) expect(gap).toBeLessThanOrEqual(1);
  });

  it(`a caller's retries are capped at MAX_CRAWL_RETRIES (${MAX_CRAWL_RETRIES})`, async () => {
    const client = new HttpClient({ crawl: { retryJitter: false, retryBaseDelayMs: 0, minIntervalMs: 0, adaptiveThrottle: false } });
    const h = attach(client, () => ({ status: 502 }));

    await settle(inScrape({ site: 'x', caller: { retries: 50 } }, () => client.get(URL_A)));

    expect(h.sent).toHaveLength(MAX_CRAWL_RETRIES + 1);
  });

  it('a hostile Retry-After cools the bucket for at most EVER_JOBS_CRAWL_MAX_COOLDOWN_MS (default 1 h)', async () => {
    const client = new HttpClient({ retries: 0 });
    attach(client, () => ({ status: 429, headers: { 'retry-after': '99999999999' } }));

    await settle(client.get(URL_A), 0);

    expect(getHostLimiter().coolingDownUntil('host:acme.example.com') - Date.now()).toBe(3_600_000);
  });

  it('a 429 the caller accepts (validateStatus) still backs the bucket off, without a retry', async () => {
    const client = new HttpClient({ retries: 3 });
    const h = attach(client, () => ({ status: 429, headers: { 'retry-after': '30' } }));
    const limiter = getHostLimiter();

    const first = await settle(client.get(URL_A, { validateStatus: () => true }), 0);
    const cooling = limiter.coolingDownUntil('host:acme.example.com') - Date.now();
    const second = client.get(URL_A, { validateStatus: () => true });
    await jest.advanceTimersByTimeAsync(29_000);
    const sentBefore = h.sent.length;
    await jest.advanceTimersByTimeAsync(2_000);
    await second;

    expect((first as { status: number }).status).toBe(429);
    expect(cooling).toBe(30_000);
    expect(limiter.slowdownOf('host:acme.example.com')).toBeGreaterThan(1);
    expect(sentBefore).toBe(1);
    expect(h.sent).toHaveLength(2);
  });

  it('a 503 accepted with a Retry-After over the max cools the bucket (give-up) and the next request fails fast', async () => {
    const client = new HttpClient();
    attach(client, () => ({ status: 503, headers: { 'retry-after': '3600' } }));

    const first = await settle(client.get(URL_A, { validateStatus: () => true }), 0);
    const second = await settle(client.get(URL_A, { validateStatus: () => true }), 0);

    expect((first as { status: number }).status).toBe(503);
    expect(second).toBeInstanceOf(HostCoolingDownError);
  });

  it('legacy: an accepted 429 does not pace the (unpaced) bucket, as before 1690', async () => {
    setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 429, headers: { 'retry-after': '30' } }));

    await settle(Promise.all([0, 1, 2].map(() => client.get(URL_A, { validateStatus: () => true }))), 0);

    expect(h.sent).toHaveLength(3);
    expect(getHostLimiter().coolingDownUntil('host:acme.example.com')).toBe(0);
  });

  it('a 429 penalizes the whole bucket even with EVER_JOBS_CRAWL_ADAPTIVE=false (the bucket is paced)', async () => {
    setEnv({ [CRAWL_ENV.ADAPTIVE]: 'false' });
    const client = new HttpClient({ retries: 0 });
    attach(client, () => ({ status: 429, headers: { 'retry-after': '20' } }));

    await settle(client.get(URL_A), 0);

    expect(getHostLimiter().coolingDownUntil('host:acme.example.com') - Date.now()).toBe(20_000);
  });

  it('with maxQueueWaitMs, a request to a cooling bucket fails fast', async () => {
    setEnv({ [CRAWL_ENV.MAX_QUEUE_WAIT_MS]: '5000' });
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 429, headers: { 'retry-after': '120' } }));

    await settle(client.get(URL_A), 0);
    const second = await settle(client.get(URL_A), 0);

    expect(second).toBeInstanceOf(HostCoolingDownError);
    expect(h.sent).toHaveLength(1);
  });

  it('retryAfterOverMax=cap waits maxRetryAfterMs (not retryMaxDelayMs) and retries', async () => {
    setEnv({ [CRAWL_ENV.RETRY_AFTER_OVER_MAX]: 'cap' });
    const client = new HttpClient();
    const warn = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '120' } } : { status: 200 }));

    await settle(client.get(URL_A), 120_000);

    expect(h.sent).toHaveLength(2);
    expect(warn.mock.calls[0][0]).toContain('in 60000ms (host:acme.example.com)');
  });

  it('retryAfterOverMax=cap: a Retry-After within maxRetryAfterMs is honoured in full, even past retryMaxDelayMs', async () => {
    setEnv({ [CRAWL_ENV.RETRY_AFTER_OVER_MAX]: 'cap' });
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '45' } } : { status: 200 }));

    await settle(client.get(URL_A), 120_000);

    expect(gaps(h.sent)[0]).toBeGreaterThanOrEqual(45_000);
  });

  it('legacy + a larger retryMaxDelay honours a longer Retry-After, exactly as before 1690', async () => {
    setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
    const client = new HttpClient({ retryMaxDelay: 60_000 });
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '45' } } : { status: 200 }));

    await settle(client.get(URL_A), 120_000);

    expect(gaps(h.sent)[0]).toBe(45_000);
  });

  it('a 429 backs the whole bucket off, not other hosts', async () => {
    const client = new HttpClient({ retries: 0 });
    const h = attach(client, (c) => (String(c.url).endsWith('/first') ? { status: 429, headers: { 'retry-after': '5' } } : { status: 200 }));

    await settle(client.get(`${URL_A}/first`), 0);
    const t0 = Date.now();
    await settle(Promise.all([client.get(`${URL_A}/second`), client.get('https://other.example.org/x')]), 10_000);

    const at = (suffix: string) => h.sent.find((s) => s.url.endsWith(suffix))!.startedAt - t0;
    expect(at('/second')).toBeGreaterThanOrEqual(5000);
    expect(at('/x')).toBe(0);
  });

  it('adaptive throttle: a 429 doubles the bucket slowdown, a success decays it', async () => {
    const client = new HttpClient({ retries: 1, crawl: { retryJitter: false } });
    attach(client, (_c, i) => (i === 0 ? { status: 429 } : { status: 200 }));
    const limiter = getHostLimiter();
    const record = jest.spyOn(limiter, 'recordOutcome');

    await settle(client.get(URL_A));

    expect(record.mock.calls.map((c) => c[1])).toEqual(['throttled', 'ok']);
    expect(limiter.slowdownOf('host:acme.example.com')).toBeCloseTo(1.6);
  });

  it('network errors: not retried by default; ECONNRESET is with retryOnNetworkError; ENOTFOUND never', async () => {
    const reset = () => Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const notFound = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });

    const plain = new HttpClient();
    const hp = attach(plain, () => reset());
    await settle(plain.get(URL_A));

    setEnv({ [CRAWL_ENV.RETRY_ON_NETWORK_ERROR]: 'true' });
    const retrying = new HttpClient();
    const hr = attach(retrying, (_c, i) => (i < 2 ? reset() : { status: 200 }));
    const ok = await settle(retrying.get(URL_A));
    const dns = new HttpClient();
    const hn = attach(dns, () => notFound());
    await settle(dns.get(URL_A));

    expect(hp.sent).toHaveLength(1);
    expect(hr.sent).toHaveLength(3);
    expect(ok).not.toBeInstanceOf(Error);
    expect(hn.sent).toHaveLength(1);
  });
});

// ── throttle floor ───────────────────────────────────────────────────────────

describe('back-off floor for 429/503 without Retry-After (throttleRetryDelayMs, Spec 1690 §4.5)', () => {
  it.each([429, 503])('a %d without Retry-After is not retried before 5 s, then 10 s (polite, jitter on)', async (status) => {
    const client = new HttpClient();
    const warn = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    const h = attach(client, (_c, i) => (i < 2 ? { status } : { status: 200 }));

    const result = client.get(URL_A);
    await jest.advanceTimersByTimeAsync(4_999);
    const beforeFloor = h.sent.length;
    await jest.advanceTimersByTimeAsync(1);
    const atFloor = h.sent.length;
    await jest.advanceTimersByTimeAsync(9_999);
    const beforeSecondFloor = h.sent.length;
    await jest.advanceTimersByTimeAsync(1);
    const response = await result;

    expect(beforeFloor).toBe(1);
    expect(atFloor).toBe(2);
    expect(beforeSecondFloor).toBe(2);
    expect(h.sent).toHaveLength(3);
    expect(response.status).toBe(200);
    expect(gaps(h.sent)).toEqual([5000, 10_000]);
    expect(warn.mock.calls.map((c) => /in (\d+)ms/.exec(c[0] as string)?.[1])).toEqual(['5000', '10000']);
  });

  it('a second request to the same host waits out the bucket cool-down; other hosts do not', async () => {
    const client = new HttpClient({ retries: 0 });
    const h = attach(client, (c) => (String(c.url).endsWith('/first') ? { status: 429 } : { status: 200 }));

    const first = await settle(client.get(`${URL_A}/first`), 0);
    const t0 = Date.now();
    const cooling = getHostLimiter().coolingDownUntil('host:acme.example.com') - t0;
    const second = client.get(`${URL_A}/second`);
    const other = client.get('https://other.example.org/x');
    await jest.advanceTimersByTimeAsync(4_999);
    const sentBeforeCoolDownEnds = h.sent.map((s) => s.url);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([second, other]);

    expect((first as AxiosError).response?.status).toBe(429);
    expect(cooling).toBe(5000);
    expect(sentBeforeCoolDownEnds).toEqual([`${URL_A}/first`, 'https://other.example.org/x']);
    expect(h.sent.find((s) => s.url.endsWith('/second'))!.startedAt - t0).toBe(5000);
  });

  it('a 429 the caller accepts (validateStatus) cools the bucket for the floor too', async () => {
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429 } : { status: 200 }));

    const first = await settle(client.get(URL_A, { validateStatus: () => true }), 0);
    const cooling = getHostLimiter().coolingDownUntil('host:acme.example.com') - Date.now();
    const second = client.get(URL_A);
    await jest.advanceTimersByTimeAsync(4_999);
    const sentBefore = h.sent.length;
    await jest.advanceTimersByTimeAsync(1);
    await second;

    expect((first as { status: number }).status).toBe(429);
    expect(cooling).toBe(5000);
    expect(sentBefore).toBe(1);
    expect(h.sent).toHaveLength(2);
  });

  it('a Retry-After shorter than the floor is lifted to the floor; a longer one wins', async () => {
    const short = new HttpClient();
    const hs = attach(short, (_c, i) => (i === 0 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200 }));
    await settle(short.get(URL_A));

    resetCrawlState();
    const long = new HttpClient();
    const hl = attach(long, (_c, i) => (i === 0 ? { status: 503, headers: { 'retry-after': '8' } } : { status: 200 }));
    await settle(long.get(URL_A));

    expect(gaps(hs.sent)).toEqual([5000]);
    expect(gaps(hl.sent)).toEqual([8000]);
  });

  it('502 (and other non-throttling retries) keep the plain backoff and do not cool the bucket', async () => {
    const client = new HttpClient({ crawl: { retryJitter: false } });
    const h = attach(client, (_c, i) => (i === 0 ? { status: 502 } : { status: 200 }));
    const penalize = jest.spyOn(getHostLimiter(), 'penalize');

    await settle(client.get(URL_A));

    expect(gaps(h.sent)).toEqual([1000]);
    expect(penalize).not.toHaveBeenCalled();
  });

  it('EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS sets the floor; 0 restores the plain (jittered) backoff', async () => {
    setEnv({ [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: '2000' });
    const custom = new HttpClient({ crawl: { retryJitter: false } });
    const hc = attach(custom, (_c, i) => (i < 2 ? { status: 429 } : { status: 200 }));
    await settle(custom.get(URL_A));

    setEnv({ [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS]: '0' });
    const off = new HttpClient({ crawl: { retryJitter: false } });
    const ho = attach(off, (_c, i) => (i < 2 ? { status: 429 } : { status: 200 }));
    await settle(off.get(URL_A));

    expect(gaps(hc.sent)).toEqual([2000, 4000]);
    expect(gaps(ho.sent)).toEqual([1000, 2000]);
  });

  it('a per-request crawl override can raise the floor for one request', async () => {
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429 } : { status: 200 }));

    const config: import('../src/http/http-client').CrawlRequestConfig = { crawl: { throttleRetryDelayMs: 12_000 } };

    await settle(client.get(URL_A, config));

    expect(gaps(h.sent)).toEqual([12_000]);
  });

  it('legacy: a 429 without Retry-After is retried after the pre-1690 linear backoff, with no cool-down', async () => {
    setEnv({ [CRAWL_ENV.PRESET]: 'legacy' });
    const client = new HttpClient();
    const h = attach(client, (_c, i) => (i === 0 ? { status: 429 } : { status: 200 }));

    await settle(client.get(URL_A));

    expect(client.crawlPolicyFor(URL_A).throttleRetryDelayMs).toBe(0);
    expect(gaps(h.sent)).toEqual([1000]);
    expect(getHostLimiter().coolingDownUntil('host:acme.example.com')).toBe(0);
  });
});

// ── abort ────────────────────────────────────────────────────────────────────

describe('abort (Spec 1690 §4.6)', () => {
  it('the scrape signal empties the queue and cancels the request in flight', async () => {
    const controller = new AbortController();
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 200, hang: true }));

    const all = inScrape({ site: 's', plugin: { maxConcurrentPerHost: 1 }, signal: controller.signal }, () =>
      Promise.allSettled([client.get(URL_A), client.get(URL_A), client.get(URL_A)]),
    );
    await jest.advanceTimersByTimeAsync(100);
    expect(h.sent).toHaveLength(1);
    controller.abort(new Error('search deadline'));
    const results = await settle(all, 0);

    expect((results as PromiseSettledResult<unknown>[]).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(h.sent).toHaveLength(1);
    expect((h.sent[0].config.signal as AbortSignal).aborted).toBe(true);
    expect(getHostLimiter().snapshot()[0]).toMatchObject({ active: 0, queued: 0 });
  });

  it('a signal on the request itself is honoured alongside the scrape one', async () => {
    const own = new AbortController();
    const scrape = new AbortController();
    const client = new HttpClient();
    const h = attach(client, () => ({ status: 200, hang: true }));

    const pending = inScrape({ site: 's', signal: scrape.signal }, () => client.get(URL_A, { signal: own.signal }));
    await jest.advanceTimersByTimeAsync(10);
    own.abort();
    const result = await settle(pending, 0);

    expect(result).toBeInstanceOf(Error);
    expect(h.sent).toHaveLength(1);
    expect(scrape.signal.aborted).toBe(false);
  });

  it('an abort during the wait between retries stops the retry', async () => {
    const controller = new AbortController();
    const client = new HttpClient({ crawl: { retryJitter: false } });
    const h = attach(client, () => ({ status: 503 }));

    const pending = inScrape({ site: 's', signal: controller.signal }, () => client.get(URL_A));
    await jest.advanceTimersByTimeAsync(100);
    controller.abort(new Error('deadline'));
    const result = await settle(pending, 60_000);

    expect((result as Error).message).toBe('deadline');
    expect(h.sent).toHaveLength(1);
  });
});

// ── egress guard ─────────────────────────────────────────────────────────────

describe('egress guard (Spec 1690 §4.8)', () => {
  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/admin',
    'http://[::1]/',
    'http://2130706433/',
    'http://metadata.google.internal/',
    'http://intranet/',
  ])('refuses %s before any request is made', async (url) => {
    const client = new HttpClient();
    const h = attach(client);

    const err = await settle(client.get(url), 0);

    expect(err).toBeInstanceOf(EgressBlockedError);
    expect((err as EgressBlockedError).code).toBe('ERR_CRAWL_EGRESS_BLOCKED');
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a private literal even through a proxy', async () => {
    const client = new HttpClient({ proxies: ['http://p1.example:8080'] });
    const h = attach(client);

    expect(await settle(client.get('http://10.0.0.5/'), 0)).toBeInstanceOf(EgressBlockedError);
    expect(h.sent).toHaveLength(0);
  });

  it('direct connections use the DNS-guarded agents; caCert keeps rejectUnauthorized: false', async () => {
    const plain = new HttpClient();
    const hp = attach(plain);
    const selfSigned = new HttpClient({ caCert: '/etc/ssl/custom.pem' });
    const hs = attach(selfSigned);

    await settle(Promise.all([plain.get(URL_A), selfSigned.get(URL_A)]));

    const guarded = getGuardedAgents({ insecureTls: false });
    const insecure = getGuardedAgents({ insecureTls: true });
    expect(hp.sent[0].config.httpsAgent).toBe(guarded.httpsAgent);
    expect(hp.sent[0].config.httpAgent).toBe(guarded.httpAgent);
    expect(hs.sent[0].config.httpsAgent).toBe(insecure.httpsAgent);
    expect((insecure.httpsAgent as unknown as { options: { rejectUnauthorized?: boolean } }).options.rejectUnauthorized).toBe(false);
  });

  it('a proxied request uses the proxy agent', async () => {
    const client = new HttpClient({ proxies: ['http://p1.example:8080'] });
    const h = attach(client);

    await settle(client.get(URL_A));

    expect((h.sent[0].config.httpsAgent as unknown as { proxy: URL }).proxy.host).toBe('p1.example:8080');
  });

  it('egressAllowHosts (per client) exempts a name from the DNS guard too, not only literals', async () => {
    const client = new HttpClient({ egressAllowHosts: ['intranet.example.com'] });
    const h = attach(client);
    const other = new HttpClient();
    const ho = attach(other);

    await settle(client.get('https://intranet.example.com/x'));
    await settle(other.get('https://intranet.example.com/x'));

    expect(h.sent[0].config.httpsAgent).toBe(getGuardedAgents({ insecureTls: false, guard: false }).httpsAgent);
    expect(ho.sent[0].config.httpsAgent).toBe(getGuardedAgents({ insecureTls: false, guard: true }).httpsAgent);
  });

  it('a caCert client called through getAxiosInstance() is DNS-guarded too (its default agent is not "its own")', async () => {
    const client = new HttpClient({ caCert: 'x' });
    const h = attach(client);

    await settle(client.getAxiosInstance().get('http://acme.example.com/secret'));

    expect(h.sent[0].config.httpAgent).toBe(getGuardedAgents({ insecureTls: true, guard: true }).httpAgent);
    expect(h.sent[0].config.httpsAgent).toBe(getGuardedAgents({ insecureTls: true, guard: true }).httpsAgent);
  });

  it('with HTTPS_PROXY set, a NO_PROXY host goes direct and is DNS-guarded; a proxied one keeps axios defaults', async () => {
    setEnv({ HTTPS_PROXY: 'http://corp-proxy.internal:3128', NO_PROXY: 'acme.example.com' });
    const client = new HttpClient();
    const h = attach(client);

    await settle(client.get(URL_A));
    await settle(client.get('https://other.example.org/'));

    expect(h.sent[0].config.httpsAgent).toBe(getGuardedAgents({ insecureTls: false, guard: true }).httpsAgent);
    expect(h.sent[1].config.httpsAgent).toBeUndefined();
  });

  it('checks every redirect target', async () => {
    const client = new HttpClient();
    const h = attach(client);
    await settle(client.get(URL_A));
    const beforeRedirect = h.sent[0].config.beforeRedirect!;

    const response = { headers: {}, statusCode: 302 } as Parameters<typeof beforeRedirect>[1];
    const request = { url: URL_A, method: 'GET', headers: {} } as unknown as Parameters<typeof beforeRedirect>[2];

    expect(() => beforeRedirect({ href: 'http://169.254.169.254/latest', hostname: '169.254.169.254' }, response, request)).toThrow(
      EgressBlockedError,
    );
    expect(() => beforeRedirect({ href: 'https://jobs.example.org/1', hostname: 'jobs.example.org' }, response, request)).not.toThrow();
  });

  it('surfaces a DNS-guard refusal (wrapped by axios) as EgressBlockedError, without retrying', async () => {
    setEnv({ [CRAWL_ENV.RETRY_ON_NETWORK_ERROR]: 'true' });
    const client = new HttpClient();
    const h = attach(client, (config) =>
      AxiosError.from(new EgressBlockedError('rebind.example.com', 'resolves to private address 10.0.0.1'), undefined, config),
    );

    const err = await settle(client.get('https://rebind.example.com/'), 0);

    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(h.sent).toHaveLength(1);
  });

  it('EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false restores the pre-1690 behaviour', async () => {
    setEnv({ [CRAWL_ENV.BLOCK_PRIVATE_NETWORKS]: 'false' });
    const client = new HttpClient();
    const h = attach(client);

    await settle(client.get('http://127.0.0.1:4010/mock'));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].config.httpAgent).toBeUndefined();
  });

  it('exempts a local mock server through egressAllowHosts or EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS', async () => {
    const byOption = new HttpClient({ egressAllowHosts: ['127.0.0.1'] });
    const ho = attach(byOption);
    await settle(byOption.get('http://127.0.0.1:4010/mock'));

    setEnv({ [EGRESS_GUARD_ENV.ALLOW_HOSTS]: 'mock.localhost' });
    const byEnv = new HttpClient();
    const he = attach(byEnv);
    await settle(byEnv.get('http://mock.localhost:4010/mock'));

    expect(ho.sent).toHaveLength(1);
    expect(he.sent).toHaveLength(1);
  });
});

// ── proxies ──────────────────────────────────────────────────────────────────

describe('proxy rotation (Spec 1690 §4.4)', () => {
  const proxies = ['http://p1.example:8080', 'http://p2.example:8080', 'http://p3.example:8080'];
  const via = (s: Sent) => (s.config.httpsAgent as unknown as { proxy?: URL }).proxy?.host ?? 'direct';

  it('per-host (default): one stable proxy per bucket, across requests and clients', async () => {
    const a = new HttpClient({ proxies });
    const b = new HttpClient({ proxies });
    const ha = attach(a);
    const hb = attach(b);

    for (let i = 0; i < 3; i++) await settle(a.get(`${URL_A}/${i}`));
    await settle(b.get(URL_A));

    expect(new Set([...ha.sent, ...hb.sent].map(via)).size).toBe(1);
  });

  it('per-request: round-robin (pre-1690)', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-request' });
    const client = new HttpClient({ proxies });
    const h = attach(client);

    for (let i = 0; i < 4; i++) await settle(client.get(URL_A));

    expect(h.sent.map(via)).toEqual(['p1.example:8080', 'p2.example:8080', 'p3.example:8080', 'p1.example:8080']);
  });

  it('per-scrape: one proxy for the whole client, whatever the host', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-scrape' });
    resetProxyScrapeSeed(0);
    const client = new HttpClient({ proxies });
    const h = attach(client);

    await settle(client.get(URL_A));
    await settle(client.get('https://other.example.org/'));
    await settle(client.get('https://third.example.net/'));

    expect(h.sent.map(via)).toEqual(['p1.example:8080', 'p1.example:8080', 'p1.example:8080']);
  });

  it('per-scrape: successive clients (scrapes) are spread over the list, not all pinned to the first proxy', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-scrape' });
    resetProxyScrapeSeed(0);
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const client = new HttpClient({ proxies });
      const h = attach(client);
      await settle(client.get(URL_A));
      picks.push(via(h.sent[0]));
    }

    expect(picks).toEqual([
      'p1.example:8080',
      'p2.example:8080',
      'p3.example:8080',
      'p1.example:8080',
      'p2.example:8080',
      'p3.example:8080',
    ]);
  });

  it('per-scrape inside a scrape context: every client of the scrape shares one proxy (token + data client)', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-scrape' });
    resetProxyScrapeSeed(0);
    // Clients built before the scrape (a plugin's constructor) and inside it both follow the scrape's pin.
    const tokenClient = new HttpClient({ proxies });
    const tokenSent = attach(tokenClient).sent;
    const dataSent: Sent[] = [];

    await inScrape({ site: 'navjobs' }, async () => {
      await settle(tokenClient.post('https://auth.example.com/token'));
      const dataClient = new HttpClient({ proxies });
      const h = attach(dataClient);
      await settle(dataClient.get(URL_A));
      await settle(dataClient.get('https://other.example.org/page/2'));
      dataSent.push(...h.sent);
    });

    const used = [...tokenSent, ...dataSent].map(via);
    expect(used).toHaveLength(3);
    expect(new Set(used).size).toBe(1);
  });

  it('per-scrape: two scrapes are pinned separately (spread over the list), whatever their clients', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-scrape' });
    resetProxyScrapeSeed(0);
    const scrape = async (): Promise<string[]> =>
      inScrape({ site: 'francetravail' }, async () => {
        const token = new HttpClient({ proxies });
        const data = new HttpClient({ proxies });
        const ht = attach(token);
        const hd = attach(data);
        await settle(token.post('https://auth.example.com/token'));
        await settle(data.get(URL_A));
        return [...ht.sent, ...hd.sent].map(via);
      });

    const first = await scrape();
    const second = await scrape();

    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it('per-scrape: clients of one scrape given different lists each stay within their own list', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-scrape' });
    const other = ['http://q1.example:8080', 'http://q2.example:8080'];
    const seen = await inScrape({ site: 'x' }, async () => {
      const a = new HttpClient({ proxies });
      const b = new HttpClient({ proxies: other });
      const ha = attach(a);
      const hb = attach(b);
      await settle(a.get(URL_A));
      await settle(b.get(URL_A));
      return { a: via(ha.sent[0]), b: via(hb.sent[0]) };
    });

    expect(proxies.map((p) => new URL(p).host)).toContain(seen.a);
    expect(other.map((p) => new URL(p).host)).toContain(seen.b);
  });

  it('a caller (non-env) proxy on a private address is refused by the egress guard; an env proxy is trusted', async () => {
    const callerProxy = new HttpClient();
    const hc = attach(callerProxy);
    const refused = await inScrape({ site: 's', proxies: ['http://user:pw@127.0.0.1:3128'] }, () => settle(callerProxy.get(URL_A)));

    setEnv({ [CRAWL_ENV.PROXIES]: 'http://10.0.0.5:3128' });
    const envProxy = new HttpClient();
    const he = attach(envProxy);
    await settle(envProxy.get(URL_A));

    expect(refused).toBeInstanceOf(EgressBlockedError);
    expect((refused as Error).message).toContain('proxy 127.0.0.1');
    expect((refused as Error).message).not.toContain('pw');
    expect(hc.sent).toHaveLength(0);
    expect(he.sent).toHaveLength(1);
    expect(via(he.sent[0])).toBe('10.0.0.5:3128');
  });

  it('a caller proxy connects through the guarded lookup: a private DNS answer is refused (address not echoed)', async () => {
    const client = new HttpClient();
    const h = attach(client);
    await inScrape({ site: 's', proxies: ['http://proxy.example:3128'] }, () => settle(client.get(URL_A)));
    // The real module object (the guard looks `dns.lookup` up at call time).
    const dnsModule = require('dns') as typeof dns;
    jest.spyOn(dnsModule, 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address: '10.1.2.3', family: 4 }])) as unknown as typeof dns.lookup);

    const agent = h.sent[0].config.httpsAgent as unknown as {
      connectOpts: { lookup: (host: string, opts: object, cb: (err: Error | null) => void) => void };
    };
    const err = await new Promise<Error | null>((resolve) => agent.connectOpts.lookup('proxy.example', {}, resolve));

    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err!.message).not.toContain('10.1.2.3');
  });

  it('off: direct, even with a list', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'off' });
    const client = new HttpClient({ proxies });
    const h = attach(client);

    await settle(client.get(URL_A));

    expect(via(h.sent[0])).toBe('direct');
  });

  it('falls back to the scrape context proxies, then EVER_JOBS_CRAWL_PROXIES, then DEFAULT_PROXIES', async () => {
    setEnv({ [CRAWL_ENV.PROXY_ROTATION]: 'per-request', [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy.example:3128' });
    const fromLegacy = new HttpClient();
    const hl = attach(fromLegacy);
    await settle(fromLegacy.get(URL_A));

    setEnv({ [CRAWL_ENV.PROXIES]: 'http://env.example:3128' });
    const fromEnv = new HttpClient();
    const he = attach(fromEnv);
    await settle(fromEnv.get(URL_A));

    const fromCtx = new HttpClient();
    const hc = attach(fromCtx);
    await inScrape({ site: 's', proxies: ['http://ctx.example:3128'] }, () => settle(fromCtx.get(URL_A)));

    expect([via(hl.sent[0]), via(he.sent[0]), via(hc.sent[0])]).toEqual([
      'legacy.example:3128',
      'env.example:3128',
      'ctx.example:3128',
    ]);
  });
});

// ── robots.txt ───────────────────────────────────────────────────────────────

describe('robots.txt (Spec 1690 §4.7)', () => {
  const robots = (body: string) => (c: InternalAxiosRequestConfig): Reply =>
    String(c.url).endsWith('/robots.txt') ? { status: 200, data: body } : { status: 200 };

  it('off by default: never fetched', async () => {
    const client = new HttpClient();
    const h = attach(client, robots('User-agent: *\nDisallow: /'));

    await settle(client.get(URL_A));

    expect(h.sent.map((s) => s.url)).toEqual([URL_A]);
  });

  it('crawl-delay: Crawl-delay raises the bucket interval; fetched once, with the configured UA, through the limiter', async () => {
    setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'crawl-delay', [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });
    const client = new HttpClient();
    client.setHeaders({ 'User-Agent': 'Declared/5' });
    const h = attach(client, robots('User-agent: *\nCrawl-delay: 3\nDisallow: /'));

    await settle(Promise.all([1, 2, 3].map((i) => client.get(`${URL_A}/${i}`))));

    const pages = h.sent.filter((s) => !s.url.endsWith('/robots.txt'));
    const robotsFetches = h.sent.filter((s) => s.url.endsWith('/robots.txt'));
    expect(robotsFetches).toHaveLength(1);
    expect(robotsFetches[0].header('User-Agent')).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    expect(pages).toHaveLength(3);
    expect(pages[0].header('User-Agent')).toBe('Declared/5');
    expect(Math.min(...gaps(pages))).toBeGreaterThanOrEqual(3000);
    expect(pages[0].startedAt - robotsFetches[0].startedAt).toBeGreaterThanOrEqual(POLITE_CRAWL_POLICY.minIntervalMs);
  });

  it('respect: a disallowed URL fails with RobotsDisallowedError (credentials redacted); allowed ones go out', async () => {
    setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect' });
    const client = new HttpClient();
    const h = attach(client, robots('User-agent: EverJobs\nDisallow: /private\n\nUser-agent: *\nDisallow: /'));

    const denied = await settle(client.get('https://acme.example.com/private/1?token=SECRET'));
    const allowed = await settle(client.get('https://acme.example.com/public/1'));

    expect(denied).toBeInstanceOf(RobotsDisallowedError);
    expect((denied as Error).message).not.toContain('SECRET');
    expect((denied as Error).message).toContain('token=REDACTED');
    expect(allowed).not.toBeInstanceOf(Error);
    expect(h.sent.filter((s) => s.url.includes('/private'))).toHaveLength(0);
  });

  it('a missing robots.txt (404) allows everything', async () => {
    setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect' });
    const client = new HttpClient();
    const h = attach(client, (c) => (String(c.url).endsWith('/robots.txt') ? { status: 404 } : { status: 200 }));

    expect(await settle(client.get(URL_A))).not.toBeInstanceOf(Error);
    expect(h.sent.map((s) => s.url)).toEqual(['https://acme.example.com/robots.txt', URL_A]);
  });
});

// ── createHttpClient ─────────────────────────────────────────────────────────

describe('createHttpClient (Spec 1690 §4.1, §4.9)', () => {
  const createdTimeout = () => (axios.create as unknown as jest.SpyInstance).mock.calls.at(-1)![0].timeout;

  beforeEach(() => jest.spyOn(axios, 'create'));

  it('keeps a plugin timeout when proxies are set (the pre-1690 DTO branch dropped it)', () => {
    createHttpClient({ proxies: ['http://p1.example:8080'], caCert: undefined, timeout: 20 });

    expect(createdTimeout()).toBe(20_000);
  });

  it('still maps a DTO requestTimeout', () => {
    createHttpClient(new ScraperInputDto({ requestTimeout: 15 }));

    expect(createdTimeout()).toBe(15_000);
  });

  const dto = () =>
    new ScraperInputDto({
      proxies: ['http://p1.example:8080'],
      retries: 7,
      userAgent: 'DtoAgent/1',
      rateDelayMin: 5,
      crawl: { blockPrivateNetworks: false, maxConcurrentPerHost: 0 },
    });

  it("inside a scrape context, ignores a DTO's retry/rate/UA/crawl fields (the context carries them)", () => {
    const policy = inScrape({ site: 'linkedin' }, () => createHttpClient(dto()).crawlPolicyFor(URL_A));

    expect(policy.retries).toBe(POLITE_CRAWL_POLICY.retries);
    expect(policy.provenance.retries).toBe('preset');
    expect(policy.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    expect(policy.minIntervalMs).toBe(POLITE_CRAWL_POLICY.minIntervalMs);
    expect(policy.blockPrivateNetworks).toBe(true);
  });

  it('outside any context, applies them as the plugin layer, as before (the UA as a declared UA)', () => {
    const policy = createHttpClient(dto()).crawlPolicyFor(URL_A);

    expect(policy.retries).toBe(7);
    expect(policy.provenance.retries).toBe('plugin');
    // The DTO's userAgent is the client's declared UA, never the configured one.
    expect(policy.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    expect(policy.minIntervalMs).toBe(5000);
  });

  it("keeps a plugin object literal's own options inside a context", () => {
    const policy = inScrape({ site: 'liveness' }, () =>
      createHttpClient({ proxies: ['http://p1.example:8080'], requestTimeout: 5, retries: 0, userAgent: 'Liveness/1' }).crawlPolicyFor(URL_A),
    );

    expect(policy.retries).toBe(0);
    expect(policy.userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('uses the client site for the operator-site layer when no context names one', () => {
    setEnv({ [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { softy: { maxConcurrentPerHost: 1 } } }) });

    expect(createHttpClient({ site: 'softy' }).crawlPolicyFor(URL_A).maxConcurrentPerHost).toBe(1);
    expect(createHttpClient({}).crawlPolicyFor(URL_A).maxConcurrentPerHost).toBe(POLITE_CRAWL_POLICY.maxConcurrentPerHost);
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('helpers', () => {
  const policy = (over: Partial<CrawlPolicy> = {}): CrawlPolicy => ({ ...POLITE_CRAWL_POLICY, ...over });

  it('crawlOverrideFromClientOptions maps units and keeps 0 rateDelayMin as "no delay"', () => {
    expect(crawlOverrideFromClientOptions({ rateDelayMin: 1.5, rateDelayMax: 2, retries: 0, crawl: { retries: 1, jitterMs: undefined } })).toEqual({
      minIntervalMs: 1500,
      jitterMs: 500,
      retries: 1,
    });
    expect(crawlOverrideFromClientOptions({ rateDelayMin: 0, rateDelayMax: 3 })).toEqual({});
    expect(crawlOverrideFromClientOptions({ rateDelayMin: 2, rateDelayMax: 1 })).toEqual({ minIntervalMs: 2000 });
    expect(crawlOverrideFromClientOptions({ userAgent: '  ' })).toEqual({});
  });

  it.each([
    ['exponential', [1000, 2000, 4000, 8000, 16000, 30000]],
    ['linear', [1000, 2000, 3000, 4000, 5000, 6000]],
    ['constant', [1000, 1000, 1000, 1000, 1000, 1000]],
  ] as const)('retryBackoffMs %s (no jitter, capped at retryMaxDelayMs)', (kind, expected) => {
    const p = policy({ retryBackoff: kind, retryJitter: false });
    expect([0, 1, 2, 3, 4, 5].map((a) => retryBackoffMs(p, a))).toEqual(expected);
  });

  it('retryBackoffMs full jitter spans 0..backoff', () => {
    const p = policy({ retryJitter: true });
    expect(retryBackoffMs(p, 2, () => 0)).toBe(0);
    expect(retryBackoffMs(p, 2, () => 0.999999)).toBe(4000);
    expect(retryBackoffMs(policy({ retryBaseDelayMs: 0 }), 5000)).toBe(0);
    expect(retryBackoffMs(policy({ retryJitter: false }), 5000)).toBe(30000);
  });

  it('retryDecision follows §4.5 in give-up and cap modes', () => {
    const noJitter = policy({ retryJitter: false });
    expect(retryDecision(noJitter, 0, null)).toEqual({ delayMs: 1000 });
    expect(retryDecision(noJitter, 0, 45_000)).toEqual({ delayMs: 45_000 });
    expect(retryDecision(noJitter, 0, 61_000)).toEqual({ giveUpAfterMs: 61_000 });
    expect(retryDecision({ ...noJitter, respectRetryAfter: false }, 0, 61_000)).toEqual({ delayMs: 1000 });
    const legacy = { ...LEGACY_CRAWL_POLICY };
    expect(retryDecision(legacy, 0, 120_000)).toEqual({ delayMs: 30_000 });
    expect(retryDecision(legacy, 1, 1_000)).toEqual({ delayMs: 2000 });
    // The resolver ties legacy's maxRetryAfterMs to retryMaxDelayMs (pre-1690: one ceiling).
    expect(retryDecision({ ...legacy, retryMaxDelayMs: 3000, maxRetryAfterMs: 3000 }, 0, 600_000)).toEqual({ delayMs: 3000 });
    expect(retryDecision({ ...legacy, retryMaxDelayMs: 60_000, maxRetryAfterMs: 60_000 }, 0, 45_000)).toEqual({ delayMs: 45_000 });
    // cap with the polite limits: never earlier than asked up to maxRetryAfterMs, then maxRetryAfterMs.
    const cap = policy({ retryJitter: false, retryAfterOverMax: 'cap' });
    expect(retryDecision(cap, 0, 45_000)).toEqual({ delayMs: 45_000 });
    expect(retryDecision(cap, 0, 120_000)).toEqual({ delayMs: 60_000 });
  });

  it('retryDecision minDelayMs: a floor only when the un-jittered back-off is below it; 0 = off', () => {
    const zero = policy({ retryBaseDelayMs: 0, retryJitter: false });
    expect(retryDecision(zero, 0, null)).toEqual({ delayMs: 0 });
    expect(retryDecision(zero, 5, null, Math.random, 502, 100)).toEqual({ delayMs: 100 });
    expect(retryDecision({ ...zero, retryMaxDelayMs: 0 }, 0, null, Math.random, undefined, 100)).toEqual({ delayMs: 100 });
    // A longer Retry-After (within the max) still wins; a give-up is unchanged.
    expect(retryDecision(zero, 0, 2000, Math.random, 502, 100)).toEqual({ delayMs: 2000 });
    expect(retryDecision(zero, 0, 120_000, Math.random, 429, 100)).toEqual({ giveUpAfterMs: 120_000 });
    // A normal back-off keeps its full jitter (a draw of 0 stays 0).
    const jittered = policy({ retryJitter: true });
    expect(retryDecision(jittered, 0, null, () => 0, 502, 100)).toEqual({ delayMs: 0 });
    // 429/503 already wait the throttle floor, far above the minimum.
    expect(retryDecision({ ...zero, throttleRetryDelayMs: 5000 }, 0, null, Math.random, 429, 100)).toEqual({ delayMs: 5000 });
  });

  it('crawlAcquireOptions: the policy as limiter options, Crawl-delay raising the interval', () => {
    const signal = new AbortController().signal;
    expect(crawlAcquireOptions(POLITE_CRAWL_POLICY, signal, 2000)).toEqual({
      maxConcurrent: 4,
      minIntervalMs: 2000,
      jitterMs: 0,
      maxWaitMs: 0,
      adaptive: true,
      maxCoolDownWaitMs: 60_000,
      signal,
    });
    expect(crawlAcquireOptions({ ...POLITE_CRAWL_POLICY, maxQueueWaitMs: 5000 })).toMatchObject({
      minIntervalMs: 100,
      maxWaitMs: 5000,
      maxCoolDownWaitMs: 0,
    });
  });

  it('recordAnswerOutcome: 429/503 throttle and back off (give-up for the full Retry-After); others are ok', () => {
    const limiter = new HostLimiter();
    const record = jest.spyOn(limiter, 'recordOutcome');
    const penalize = jest.spyOn(limiter, 'penalize');

    expect(recordAnswerOutcome(limiter, 'host:a', POLITE_CRAWL_POLICY, 0, 200, {})).toEqual({ throttled: false });
    expect(recordAnswerOutcome(limiter, 'host:a', POLITE_CRAWL_POLICY, 0, 429, { 'Retry-After': '300' })).toEqual({
      throttled: true,
      giveUpAfterMs: 300_000,
    });
    expect(recordAnswerOutcome(limiter, 'host:b', POLITE_CRAWL_POLICY, 0, 503, {})).toEqual({ throttled: true, backOffMs: 5000 });
    expect(recordAnswerOutcome(limiter, 'host:c', LEGACY_CRAWL_POLICY, 0, 429, {})).toEqual({ throttled: true });

    expect(record.mock.calls.map((c) => c[1])).toEqual(['ok', 'throttled', 'throttled', 'throttled']);
    expect(penalize.mock.calls).toEqual([
      ['host:a', 300_000],
      ['host:b', 5000],
    ]);
  });

  it('penalizesBucket: any pacing at all (concurrency, interval or adaptive); never for an unpaced policy', () => {
    expect(penalizesBucket(POLITE_CRAWL_POLICY)).toBe(true);
    expect(penalizesBucket({ ...POLITE_CRAWL_POLICY, adaptiveThrottle: false })).toBe(true);
    expect(penalizesBucket({ maxConcurrentPerHost: 0, minIntervalMs: 0, adaptiveThrottle: true })).toBe(true);
    expect(penalizesBucket(LEGACY_CRAWL_POLICY)).toBe(false);
  });

  it('penalizesBucket: a throttle floor counts as pacing; 0 (legacy) does not', () => {
    const unpaced = { maxConcurrentPerHost: 0, minIntervalMs: 0, adaptiveThrottle: false };
    expect(penalizesBucket({ ...unpaced, throttleRetryDelayMs: 5000 })).toBe(true);
    expect(penalizesBucket({ ...unpaced, throttleRetryDelayMs: 0 })).toBe(false);
    expect(penalizesBucket(unpaced)).toBe(false);
  });

  describe('throttle floor (throttleRetryDelayMs)', () => {
    const polite = policy(); // jitter on, as by default
    const zero = () => 0;
    const almostOne = () => 0.999999;

    it('throttleRetryFloorMs: floor × 2^attempt for 429/503, capped at max(retryMaxDelayMs, floor); 0 otherwise', () => {
      expect([0, 1, 2, 3, 4, 40, 5000].map((a) => throttleRetryFloorMs(polite, a, 429))).toEqual([
        5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000,
      ]);
      expect(throttleRetryFloorMs(polite, 1, 503)).toBe(10_000);
      for (const status of [502, 504, 500, 404, 200, undefined]) expect(throttleRetryFloorMs(polite, 0, status)).toBe(0);
      expect(throttleRetryFloorMs(policy({ throttleRetryDelayMs: 0 }), 0, 429)).toBe(0);
      expect(throttleRetryFloorMs({ retryMaxDelayMs: 30_000 }, 0, 429)).toBe(0); // field absent = off
      // A floor above retryMaxDelayMs is its own cap.
      expect([0, 1].map((a) => throttleRetryFloorMs(policy({ throttleRetryDelayMs: 60_000 }), a, 429))).toEqual([60_000, 60_000]);
    });

    it.each([429, 503])('%d without Retry-After: attempt 0 ≥ 5000, attempt 1 ≥ 10000, capped at 30000', (status) => {
      for (const random of [zero, almostOne]) {
        expect(retryDecision(polite, 0, null, random, status)).toEqual({ delayMs: 5000 });
        expect(retryDecision(polite, 1, null, random, status)).toEqual({ delayMs: 10_000 });
        expect(retryDecision(polite, 2, null, random, status)).toEqual({ delayMs: 20_000 });
        expect(retryDecision(polite, 3, null, random, status)).toEqual({ delayMs: 30_000 });
        expect(retryDecision(polite, 9, null, random, status)).toEqual({ delayMs: 30_000 });
      }
      // Never less than the normal backoff (here a linear 8 s one).
      expect(retryDecision(policy({ retryBackoff: 'linear', retryBaseDelayMs: 8000, retryJitter: false }), 0, null, zero, status)).toEqual({
        delayMs: 8000,
      });
      // With respectRetryAfter off there is never a usable Retry-After: the floor applies.
      expect(retryDecision(policy({ respectRetryAfter: false }), 0, null, zero, status)).toEqual({ delayMs: 5000 });
    });

    it('502, 504 and network errors are unaffected', () => {
      for (const status of [502, 504, undefined]) {
        expect(retryDecision(polite, 0, null, zero, status)).toEqual({ delayMs: 0 });
        expect(retryDecision(polite, 1, null, almostOne, status)).toEqual({ delayMs: 2000 });
      }
    });

    it('a Retry-After within maxRetryAfterMs: max(floor, backoff, Retry-After)', () => {
      expect(retryDecision(polite, 0, 2000, zero, 429)).toEqual({ delayMs: 5000 }); // floor beats a shorter Retry-After
      expect(retryDecision(polite, 0, 7000, zero, 429)).toEqual({ delayMs: 7000 }); // a longer Retry-After wins
      expect(retryDecision(polite, 1, 45_000, zero, 503)).toEqual({ delayMs: 45_000 });
      expect(retryDecision(polite, 0, 0, zero, 429)).toEqual({ delayMs: 5000 }); // Retry-After: 0 / a past date
    });

    it('a Retry-After over maxRetryAfterMs keeps the give-up / cap behaviour', () => {
      expect(retryDecision(polite, 0, 61_000, zero, 429)).toEqual({ giveUpAfterMs: 61_000 });
      expect(retryDecision(policy({ retryAfterOverMax: 'cap' }), 0, 120_000, zero, 429)).toEqual({ delayMs: 60_000 });
      // cap never waits less than the floor would have without any Retry-After.
      expect(retryDecision(policy({ retryAfterOverMax: 'cap', throttleRetryDelayMs: 90_000 }), 0, 120_000, zero, 429)).toEqual({
        delayMs: 90_000,
      });
    });

    it('throttleRetryDelayMs 0 is exactly the pre-floor arithmetic', () => {
      const off = policy({ throttleRetryDelayMs: 0 });
      for (const attempt of [0, 1, 2, 5]) {
        for (const retryAfter of [null, 0, 2000, 45_000, 61_000]) {
          for (const status of [429, 503, 502, undefined]) {
            expect(retryDecision(off, attempt, retryAfter, almostOne, status)).toEqual(retryDecision(off, attempt, retryAfter, almostOne));
          }
        }
      }
      expect(retryDecision(off, 0, null, zero, 429)).toEqual({ delayMs: 0 });
    });

    it('the legacy preset is unaffected (floor 0): pre-1690 linear arithmetic for 429/503', () => {
      const legacy = { ...LEGACY_CRAWL_POLICY };
      expect(legacy.throttleRetryDelayMs).toBe(0);
      for (const status of [429, 503]) {
        expect([0, 1, 2].map((a) => retryDecision(legacy, a, null, Math.random, status))).toEqual([
          { delayMs: 1000 },
          { delayMs: 2000 },
          { delayMs: 3000 },
        ]);
        expect(retryDecision(legacy, 0, 120_000, Math.random, status)).toEqual({ delayMs: 30_000 });
        expect(retryDecision(legacy, 1, 1_000, Math.random, status)).toEqual({ delayMs: 2000 });
      }
    });

    it('the strict preset waits at least 30 s after a 429/503', () => {
      expect(STRICT_CRAWL_POLICY.throttleRetryDelayMs).toBe(30_000);
      expect(retryDecision(STRICT_CRAWL_POLICY, 0, null, zero, 429)).toEqual({ delayMs: 30_000 });
      expect(retryDecision(STRICT_CRAWL_POLICY, 3, null, zero, 503)).toEqual({ delayMs: 30_000 });
      expect(retryDecision(STRICT_CRAWL_POLICY, 0, 45_000, zero, 503)).toEqual({ delayMs: 45_000 });
    });
  });

  it('parseRetryAfter reads seconds and HTTP-dates', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(['5'], now)).toBe(5000);
    expect(parseRetryAfter('Thu, 24 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });

  it('isRetryableNetworkError', () => {
    expect(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error('timeout of 1ms exceeded'), { code: 'ECONNABORTED' }))).toBe(true);
    expect(isRetryableNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isRetryableNetworkError(new CanceledError())).toBe(false);
    expect(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET', response: { status: 500 } }))).toBe(false);
    expect(isRetryableNetworkError(new EgressBlockedError('h', 'r'))).toBe(false);
  });

  it('selectWireUserAgent implements the §4.2 table', () => {
    const base = { userAgent: 'Configured', userAgentMode: 'identify' as const };
    const declared = { perRequest: 'Per', setHeaders: 'Set', option: 'Opt' };
    expect(selectWireUserAgent({ policy: base, ...declared }).userAgent).toBe('Configured');
    expect(selectWireUserAgent({ policy: base, ...declared, pluginOptIn: true }).userAgent).toBe('Per');
    expect(selectWireUserAgent({ policy: base, pluginOptIn: true }).source).toBe('configured');
    expect(selectWireUserAgent({ policy: { ...base, userAgentMode: 'plugin' }, setHeaders: 'Set', option: 'Opt' }).userAgent).toBe('Set');
    expect(selectWireUserAgent({ policy: { ...base, userAgentMode: 'plugin' }, option: 'Opt' }).userAgent).toBe('Opt');
    expect(selectWireUserAgent({ policy: { ...base, userAgentMode: 'strict' }, ...declared, pluginOptIn: true }).userAgent).toBe('Configured');
    expect(selectWireUserAgent({ policy: { ...base, userAgentMode: 'strict' }, setHeaders: 'Set', legacy: true }).userAgent).toBe('Configured');
    expect(selectWireUserAgent({ policy: { ...base, userAgentMode: 'strict' }, ...declared, legacy: true }).userAgent).toBe('Per');
  });
});
