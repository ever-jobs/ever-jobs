import 'reflect-metadata';
import {
  CrawlPolicyDto,
  IScraper,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  POLITE_CRAWL_POLICY,
  PluginCrawlPolicy,
  ScrapeContext,
  getScrapeContext,
  resetCrawlPolicyEnvCache,
} from '@ever-jobs/common';
import { CircuitBreakerInterceptor, CircuitBreakerService } from '@ever-jobs/plugin';
import { ERR_SCRAPE_DEADLINE_ABORTED, JobsService } from '../jobs.service';

/**
 * Spec 1690 §4.1 / §4.6 — `JobsService.scrapeOne` runs every scrape inside a
 * scrape context (site, plugin manifest crawl, caller override, deadline
 * signal, caller proxies), builds the caller layer ONLY from what the caller
 * sent, and aborts a source the search deadline abandons.
 */

interface Seen {
  ctx?: ScrapeContext;
  ctxAfterAwait?: ScrapeContext;
  input?: ScraperInputDto;
}

/** A scraper that records the scrape context it runs under and its DTO. */
function capturingScraper(): { scraper: IScraper; seen: Seen } {
  const seen: Seen = {};
  const scraper: IScraper = {
    scrape: jest.fn(async (input: ScraperInputDto) => {
      seen.ctx = getScrapeContext();
      seen.input = input;
      await new Promise((resolve) => setImmediate(resolve));
      seen.ctxAfterAwait = getScrapeContext();
      return new JobResponseDto([]);
    }),
  };
  return { scraper, seen };
}

/**
 * A scraper that only settles when its scrape-context signal aborts (a stand-in
 * for HttpClient cancelling queued/in-flight requests), or when released.
 */
function hangingScraper(): { scraper: IScraper; signals: AbortSignal[]; release: () => void } {
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const scraper: IScraper = {
    scrape: jest.fn(
      () =>
        new Promise<JobResponseDto>((resolve, reject) => {
          const signal = getScrapeContext()?.signal;
          if (signal) {
            signals.push(signal);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }
          releases.push(() => resolve(new JobResponseDto([])));
        }),
    ),
  };
  return { scraper, signals, release: () => releases.forEach((r) => r()) };
}

interface ServiceOptions {
  deadlineMs?: number;
  /** `crawl` of the registry's plugin metadata, per site. `null` = registry without `getMetadata`. */
  pluginCrawl?: Partial<Record<Site, PluginCrawlPolicy>> | null;
  retry?: Record<string, unknown>;
  circuitBreaker?: CircuitBreakerInterceptor;
}

function createService(entries: [Site, IScraper][], opts: ServiceOptions = {}) {
  const scraperMap = new Map<Site, IScraper>(entries);
  const service: any = Object.create(JobsService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  service.registry = {
    size: scraperMap.size,
    siteForDomain: () => undefined,
    getScraper: (site: Site) => scraperMap.get(site),
    listSiteKeys: () => [...scraperMap.keys()],
    listAtsSites: () => [],
    listSources: () => [],
    ...(opts.pluginCrawl === null
      ? {}
      : {
          getMetadata: (site: Site) => ({
            site,
            name: String(site),
            category: 'job-board',
            ...(opts.pluginCrawl?.[site] ? { crawl: opts.pluginCrawl[site] } : {}),
          }),
        }),
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') {
        return (
          opts.retry ?? { defaultRetries: 3, defaultDelayMs: 1000, defaultBackoff: 'linear', perSource: {} }
        );
      }
      if (key === 'search.concurrency') return 64;
      if (key === 'search.deadlineMs') return opts.deadlineMs ?? 0;
      return def;
    },
  };
  service.metrics = {
    scraperDuration: { startTimer: () => () => undefined },
    scraperRequestsTotal: { inc: jest.fn() },
  };
  service.circuitBreaker = opts.circuitBreaker;
  // Test handles on the stubs (the real fields are private).
  service.spies = { logger: service.logger, inc: service.metrics.scraperRequestsTotal.inc };
  return service as JobsService & { spies: { logger: Record<string, jest.Mock>; inc: jest.Mock } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ENV_KEYS = [CRAWL_ENV.ABORT_ON_DEADLINE, CRAWL_ENV.CALLER_OVERRIDES, CRAWL_EXTRA_ENV.CALLER_PROXIES];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetCrawlPolicyEnvCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetCrawlPolicyEnvCache();
});

describe('JobsService — scrape context (Spec 1690 §4.1/§4.6)', () => {
  it('runs the scrape inside a context carrying site, plugin crawl, signal and proxies', async () => {
    const { scraper, seen } = capturingScraper();
    const pluginCrawl: PluginCrawlPolicy = { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 };
    const service = createService([[Site.SOFTY, scraper]], { pluginCrawl: { [Site.SOFTY]: pluginCrawl } });

    await service.searchJobs(
      new ScraperInputDto({ siteType: [Site.SOFTY], companySlug: 'acme', proxies: ['http://p1:8080'] }),
    );

    expect(seen.ctx).toBeDefined();
    expect(seen.ctx!.site).toBe(Site.SOFTY);
    expect(seen.ctx!.plugin).toEqual(pluginCrawl);
    expect(seen.ctx!.proxies).toEqual(['http://p1:8080']);
    expect(seen.ctx!.signal).toBeInstanceOf(AbortSignal);
    expect(seen.ctx!.signal!.aborted).toBe(false);
    // The context survives awaits inside the plugin (AsyncLocalStorage).
    expect(seen.ctxAfterAwait?.site).toBe(Site.SOFTY);
    // Outside the scrape there is no scrape context.
    expect(getScrapeContext()).toBeUndefined();
  });

  it('carries no caller override when the caller sent no crawl or legacy fields — FILLED retry defaults stay out', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]], {
      retry: {
        defaultRetries: 3,
        defaultDelayMs: 1000,
        defaultBackoff: 'linear',
        perSource: { [Site.LINKEDIN]: { retries: 7, delayMs: 50, backoff: 'exponential', maxDelayMs: 900 } },
      },
    });

    await service.searchJobs(new ScraperInputDto({ siteType: [Site.LINKEDIN], searchTerm: 'x' }));

    // Backward compatibility: the plugin still receives the filled DTO…
    expect(seen.input).toMatchObject({ retries: 7, retryDelay: 50, retryBackoff: 'exponential', retryMaxDelay: 900 });
    // …but none of those filled values became a caller override.
    expect(seen.ctx!.caller).toBeUndefined();
  });

  it('maps the legacy flat fields the caller actually sent into the caller layer', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]]);

    await service.searchJobs(
      new ScraperInputDto({
        siteType: [Site.LINKEDIN],
        userAgent: 'AcmeBot/1.0 (+https://acme.example/bot)',
        rateDelayMin: 1,
        rateDelayMax: 1.5,
        retries: 1,
        retryDelay: 200,
        retryBackoff: 'exponential',
        retryMaxDelay: 4000,
      }),
    );

    expect(seen.ctx!.caller).toEqual({
      userAgent: 'AcmeBot/1.0 (+https://acme.example/bot)',
      userAgentMode: 'strict',
      minIntervalMs: 1000,
      jitterMs: 500,
      retries: 1,
      retryBaseDelayMs: 200,
      retryBackoff: 'exponential',
      retryMaxDelayMs: 4000,
    });
  });

  it('merges input.crawl over the legacy fields (crawl wins) and keeps its other knobs', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]]);
    const crawl = Object.assign(new CrawlPolicyDto(), {
      userAgentMode: 'plugin' as const,
      minIntervalMs: 2500,
      maxConcurrentPerHost: 2,
      proxyRotation: 'off' as const,
      discovery: 'listing' as const,
    });

    await service.searchJobs(
      new ScraperInputDto({ siteType: [Site.LINKEDIN], userAgent: 'AcmeBot/1.0', rateDelayMin: 1, crawl }),
    );

    expect(seen.ctx!.caller).toEqual({
      userAgent: 'AcmeBot/1.0',
      userAgentMode: 'plugin',
      minIntervalMs: 2500,
      maxConcurrentPerHost: 2,
      proxyRotation: 'off',
      discovery: 'listing',
    });
  });

  it('builds the caller override once per search and shares it across sources', async () => {
    const a = capturingScraper();
    const b = capturingScraper();
    const service = createService([
      [Site.LINKEDIN, a.scraper],
      [Site.INDEED, b.scraper],
    ]);

    await service.searchJobs(
      new ScraperInputDto({
        siteType: [Site.LINKEDIN, Site.INDEED],
        retryBackoff: 'fibonacci' as never,
        crawl: Object.assign(new CrawlPolicyDto(), { maxConcurrentPerHost: 1 }),
      }),
    );

    expect(a.seen.ctx!.caller).toEqual({ maxConcurrentPerHost: 1 });
    expect(a.seen.ctx!.caller).toBe(b.seen.ctx!.caller);
    // The unmappable legacy value is reported once per search, not per source.
    const crawlWarnings = service.spies.logger.warn.mock.calls.filter(([m]: [string]) =>
      String(m).startsWith('Search crawl policy'),
    );
    expect(crawlWarnings).toHaveLength(1);
    expect(crawlWarnings[0][0]).toContain('retryBackoff');
  });

  it('works with a registry that has no getMetadata (plugin layer simply absent)', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]], { pluginCrawl: null });

    await service.searchJobs(new ScraperInputDto({ siteType: [Site.LINKEDIN] }));

    expect(seen.ctx!.site).toBe(Site.LINKEDIN);
    expect(seen.ctx!.plugin).toBeUndefined();
  });

  it('a direct scrapeOne call (no per-search options) still builds the caller override from its input', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]]);

    await (service as any).scrapeOne(
      Site.LINKEDIN,
      scraper,
      new ScraperInputDto({ crawl: Object.assign(new CrawlPolicyDto(), { robotsTxt: 'respect' as const }) }),
    );

    expect(seen.ctx!.caller).toEqual({ robotsTxt: 'respect' });
    expect(seen.ctx!.signal).toBeUndefined();
  });

  describe('caller proxies (EVER_JOBS_CRAWL_CALLER_PROXIES)', () => {
    const search = async () => {
      const { scraper, seen } = capturingScraper();
      const service = createService([[Site.LINKEDIN, scraper]]);
      await service.searchJobs(new ScraperInputDto({ siteType: [Site.LINKEDIN], proxies: ['http://p1:8080'] }));
      return { seen, service };
    };

    it('reach the context and the DTO by default (caller overrides "any")', async () => {
      const { seen } = await search();
      expect(seen.ctx!.proxies).toEqual(['http://p1:8080']);
      expect(seen.input!.proxies).toEqual(['http://p1:8080']);
    });

    it.each([
      [{ [CRAWL_EXTRA_ENV.CALLER_PROXIES]: 'none' }],
      [{ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' }],
      [{ [CRAWL_ENV.CALLER_OVERRIDES]: 'none' }],
    ])('are dropped from both the context and the DTO under %j, with one warning', async (vars) => {
      Object.assign(process.env, vars);
      resetCrawlPolicyEnvCache();
      const { seen, service } = await search();

      expect(seen.ctx!.proxies).toBeUndefined();
      expect(seen.input!.proxies).toBeUndefined();
      const warnings = service.spies.logger.warn.mock.calls.filter(([m]: [string]) => String(m).startsWith('Search proxies ignored'));
      expect(warnings).toHaveLength(1);
    });

    it('can be allowed explicitly under stricter caller overrides', async () => {
      Object.assign(process.env, { [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter', [CRAWL_EXTRA_ENV.CALLER_PROXIES]: 'any' });
      resetCrawlPolicyEnvCache();
      const { seen } = await search();
      expect(seen.ctx!.proxies).toEqual(['http://p1:8080']);
    });
  });

  it('logs the EFFECTIVE retry policy of each source, not the DTO values filled in for compatibility', async () => {
    const { scraper } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]]);

    await service.searchJobs(new ScraperInputDto({ siteType: [Site.LINKEDIN] }));

    const line = service.spies.logger.log.mock.calls.map(([m]: [string]) => String(m)).find((m) => m.startsWith('Starting search for'))!;
    expect(line).toContain(`retries=${POLITE_CRAWL_POLICY.retries}, backoff=${POLITE_CRAWL_POLICY.retryBackoff}`);
    expect(line).not.toContain('retries=3, backoff=linear');
  });
});

describe('JobsService — deadline abort (Spec 1690 §4.6)', () => {
  it('aborts the abandoned scrape so its outstanding requests stop', async () => {
    const hanging = hangingScraper();
    const service = createService([[Site.LINKEDIN, hanging.scraper]], { deadlineMs: 20 });

    const { perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.LINKEDIN] }),
    );
    await flush();

    expect(hanging.signals).toHaveLength(1);
    const [signal] = hanging.signals;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ code: ERR_SCRAPE_DEADLINE_ABORTED, name: 'AbortError', site: Site.LINKEDIN });
    // The handler still reports the source as abandoned at the deadline.
    expect(perSource).toHaveLength(1);
    expect(perSource[0].site).toBe(Site.LINKEDIN);
    expect(perSource[0].count).toBe(0);
    // Metrics/logs name the abort for what it is.
    expect(service.spies.inc).toHaveBeenCalledWith({
      site: Site.LINKEDIN,
      status: 'deadline_aborted',
    });
    expect(service.spies.logger.error).not.toHaveBeenCalled();
    expect(
      service.spies.logger.warn.mock.calls.some(([m]: [string]) => String(m).includes('abandoned 1 in-flight source')),
    ).toBe(true);
  });

  it('does not abort when EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false (pre-1690: runs on detached)', async () => {
    process.env[CRAWL_ENV.ABORT_ON_DEADLINE] = 'false';
    resetCrawlPolicyEnvCache();
    const hanging = hangingScraper();
    const service = createService([[Site.LINKEDIN, hanging.scraper]], { deadlineMs: 20 });

    const { perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.LINKEDIN] }),
    );
    await flush();

    expect(perSource).toHaveLength(1);
    expect(hanging.signals).toHaveLength(1);
    expect(hanging.signals[0].aborted).toBe(false);
    hanging.release();
    await flush();
  });

  it('a fast source is never aborted', async () => {
    const { scraper, seen } = capturingScraper();
    const service = createService([[Site.LINKEDIN, scraper]], { deadlineMs: 5_000 });

    await service.searchJobs(new ScraperInputDto({ siteType: [Site.LINKEDIN] }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen.ctx!.signal!.aborted).toBe(false);
  });

  it('keeps deadline aborts out of the circuit breaker; real failures still trip it', async () => {
    const breaker = new CircuitBreakerService();
    const interceptor = new CircuitBreakerInterceptor(breaker, breaker);

    // Five (= default failureThreshold) consecutive deadline aborts…
    for (let i = 0; i < 5; i++) {
      const hanging = hangingScraper();
      const service = createService([[Site.LINKEDIN, hanging.scraper]], {
        deadlineMs: 15,
        circuitBreaker: interceptor,
      });
      await service.searchJobsWithDiagnostics(new ScraperInputDto({ siteType: [Site.LINKEDIN] }));
      await flush();
      expect(hanging.signals[0].aborted).toBe(true);
    }
    // …leave the breaker closed with nothing recorded.
    expect(breaker.state(Site.LINKEDIN)).toBe('closed');
    expect(breaker.health(Site.LINKEDIN).successRate).toBe(1);
    expect(breaker.health(Site.LINKEDIN).lastError).toBeUndefined();

    // A source that genuinely fails is still counted.
    const failing: IScraper = { scrape: jest.fn().mockRejectedValue(new Error('HTTP 500')) };
    for (let i = 0; i < 5; i++) {
      const service = createService([[Site.INDEED, failing]], { circuitBreaker: interceptor });
      await service.searchJobsWithDiagnostics(new ScraperInputDto({ siteType: [Site.INDEED] }));
    }
    expect(breaker.state(Site.INDEED)).toBe('open');
  });
});
