import 'reflect-metadata';
import axios, { AxiosHeaders, CreateAxiosDefaults, InternalAxiosRequestConfig } from 'axios';
import { IScraper, ScraperInputDto, Site } from '@ever-jobs/models';
import {
  CRAWL_ENV,
  CRAWL_EXTRA_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  HostLimiter,
  PluginCrawlPolicy,
  getScrapeContext,
  hostLimiterOptionsFromEnv,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resetHostLimiter,
} from '@ever-jobs/common';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { RemoteOkService } from '@ever-jobs/source-remoteok';
import { WelcomeToTheJungleService } from '@ever-jobs/source-ats-wttj';
import { SimplifyJobsService } from '@ever-jobs/source-simplifyjobs';
import { JobsService } from '../jobs.service';

/**
 * Spec 1690 × Specs 1694 / 1705 / 1707, through `JobsService` and the REAL
 * `HttpClient` pipeline (policy resolution, identity interceptor, host limiter);
 * only the axios adapter is replaced, so what is recorded is what would go on
 * the wire.
 *
 * - Floors: RemoteOK (robots.txt `Crawl-delay: 1`), Welcome to the Jungle (0.5 s
 *   board pacing) and Simplify (2 s feed spacing) promise a gap a caller "may only
 *   lengthen". A search `rateDelayMin` becomes the caller layer of the crawl
 *   policy, which wins over the plugin layer the plugins' `rateDelayMin` feeds —
 *   so the plugins also set `minIntervalFloorMs`, which no layer shortens.
 * - User-Agent switches: `EVER_JOBS_REMOTEOK_LEGACY=ua` and
 *   `WTTJ_USER_AGENT_MODE=browser` only DECLARE a UA; under the default `identify`
 *   mode it reaches the wire only with the plugin-layer `userAgentMode: 'plugin'`
 *   opt-in the switches add. An operator `strict` still wins.
 *
 * The floors are measured where the limiter enforces them: the instant it GRANTS
 * each slot (see {@link recordingLimiter}), not the instant the mocked adapter runs.
 */

interface WireRequest {
  url: string;
  method: string;
  params: Record<string, unknown> | undefined;
  userAgent: string | undefined;
  /** When the adapter ran — NOT a pacing measure (see {@link recordingLimiter}). */
  at: number;
  callerMinIntervalMs: number | undefined;
}

type Reply = { status?: number; data: unknown };

const wire: WireRequest[] = [];
let reply: (config: InternalAxiosRequestConfig) => Reply = () => ({ data: '' });
const realCreate = axios.create.bind(axios);

function metadataCrawl(target: object): PluginCrawlPolicy | undefined {
  return (Reflect.getMetadata(SOURCE_PLUGIN_METADATA, target) as { crawl?: PluginCrawlPolicy } | undefined)?.crawl;
}

/** A `JobsService` over one real plugin (same shape as jobs.service.crawl.spec.ts). */
function createService(site: Site, scraper: IScraper, pluginCrawl?: PluginCrawlPolicy): JobsService {
  const service: any = Object.create(JobsService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  service.registry = {
    size: 1,
    siteForDomain: () => undefined,
    getScraper: (s: Site) => (s === site ? scraper : undefined),
    listSiteKeys: () => [site],
    listAtsSites: () => [],
    listSources: () => [],
    getMetadata: (s: Site) => ({ site: s, name: String(s), category: 'job-board', ...(pluginCrawl ? { crawl: pluginCrawl } : {}) }),
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') return { defaultRetries: 0, defaultDelayMs: 1, defaultBackoff: 'linear', perSource: {} };
      if (key === 'search.concurrency') return 4;
      if (key === 'search.deadlineMs') return 0;
      return def;
    },
  };
  service.metrics = {
    scraperDuration: { startTimer: () => () => undefined },
    scraperRequestsTotal: { inc: jest.fn() },
  };
  service.circuitBreaker = undefined;
  return service as JobsService;
}

/** One slot the limiter granted: its bucket and the limiter-clock instant of the grant. */
interface Grant {
  key: string;
  at: number;
}

const grants: Grant[] = [];

/**
 * The real process-wide `HostLimiter`, with the instant of every grant recorded:
 * the `now` its pump compared with the bucket's `nextStartAt` and from which it
 * scheduled the next slot (`nextStartAt = now + minIntervalMs…`). A floor is a
 * promise about exactly these instants, in the limiter's own `Date.now()` clock,
 * so a gap between two grants is never below the floor, and the assertions take
 * no slack.
 *
 * Why not the adapter's `Date.now()`: between the grant and the mocked adapter
 * sit the `acquire` continuation and axios's async interceptor chain. For the
 * first (cold) request of the file that path took 3-16 ms, for the next (warm)
 * one 1-3 ms, so the adapter gap read up to 13 ms under the grant gap: 987, 988
 * and 994 ms for the 1000 ms floor on loaded Linux CI runners (main run
 * 36238701455; PR #101 runs 36245459464 and 36249571368, attempt 1), while the
 * grants themselves were never less than 1000 ms apart. (Under a 16-core CPU
 * burner on Windows the adapter gap read up to 52 ms under the grant gap; Windows
 * timers wake late, which is what hid it there.)
 *
 * `grant` is private; the wrapper is checked to be installed, and every test
 * asserts one grant per wire request, so a rename cannot make it pass vacuously.
 */
function recordingLimiter(): HostLimiter {
  const limiter = new HostLimiter(hostLimiterOptionsFromEnv());
  type GrantFn = (bucket: { key: string }, waiter: unknown, now: number) => void;
  const internals = limiter as unknown as { grant?: GrantFn };
  const grant = internals.grant;
  if (typeof grant !== 'function') throw new Error('HostLimiter.grant(bucket, waiter, now) not found: update recordingLimiter()');
  internals.grant = (bucket, waiter, now) => {
    grants.push({ key: bucket.key, at: now });
    grant.call(limiter, bucket, waiter, now);
  };
  return limiter;
}

/** Gaps between consecutive grants, in the limiter's clock (ms). */
function grantGaps(): number[] {
  return grants.slice(1).map((g, i) => g.at - grants[i].at);
}

const ENV_KEYS = [
  ...Object.values(CRAWL_ENV),
  ...Object.values(CRAWL_EXTRA_ENV),
  'EVER_JOBS_REMOTEOK_LEGACY',
  'WTTJ_USER_AGENT_MODE',
  'WTTJ_BOARD_MODE',
  'EVER_JOBS_SEARCH_LOCATION_MEMO',
];
let savedEnv: Record<string, string | undefined>;

function setEnv(vars: Record<string, string>): void {
  Object.assign(process.env, vars);
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter(recordingLimiter());
  wire.length = 0;
  grants.length = 0;
  reply = () => ({ data: '' });
  jest.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults) => {
    const instance = realCreate(config);
    instance.defaults.adapter = async (cfg: InternalAxiosRequestConfig) => {
      const caller = getScrapeContext()?.caller as { minIntervalMs?: number } | undefined;
      wire.push({
        url: String(cfg.url),
        method: String(cfg.method ?? 'get').toUpperCase(),
        params: cfg.params as Record<string, unknown> | undefined,
        userAgent: (cfg.headers as AxiosHeaders).get('user-agent')?.toString(),
        at: Date.now(),
        callerMinIntervalMs: caller?.minIntervalMs,
      });
      const r = reply(cfg);
      return { data: r.data, status: r.status ?? 200, statusText: 'OK', headers: new AxiosHeaders(), config: cfg, request: {} };
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

// ── RemoteOK ────────────────────────────────────────────────────────────────

/** The tag feed answers with only the legal-notice row (→ no jobs), so the global feed is asked next. */
function remoteOkReplies(): void {
  reply = () => ({ data: [{ legal: 'API terms' }] });
}

async function searchRemoteOk(extra: Partial<ScraperInputDto> = {}): Promise<void> {
  const service = createService(Site.REMOTEOK, new RemoteOkService(), metadataCrawl(RemoteOkService));
  await service.searchJobs(new ScraperInputDto({ siteType: [Site.REMOTEOK], searchTerm: 'python', ...extra }));
}

describe('RemoteOK through JobsService (Spec 1707 × Spec 1690)', () => {
  it('a caller rateDelayMin of 0.05 s does not shorten the Crawl-delay floor between the two feeds', async () => {
    remoteOkReplies();

    await searchRemoteOk({ rateDelayMin: 0.05, rateDelayMax: 0.05 });

    expect(wire.map((r) => r.params?.tag ?? null)).toEqual(['python', null]);
    // The caller override really is in effect (the control) …
    expect(wire.every((r) => r.callerMinIntervalMs === 50)).toBe(true);
    // … every request went through a limiter slot (the instrument is live) …
    expect(grants).toHaveLength(wire.length);
    // … and the floor still holds.
    expect(grantGaps()[0]).toBeGreaterThanOrEqual(1000);
  });

  it('sends the configured honest UA by default (control)', async () => {
    remoteOkReplies();

    await searchRemoteOk();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => r.userAgent === EVER_JOBS_DEFAULT_USER_AGENT)).toBe(true);
  });

  it('EVER_JOBS_REMOTEOK_LEGACY=ua puts the pre-1707 browser UA on the wire again', async () => {
    setEnv({ EVER_JOBS_REMOTEOK_LEGACY: 'ua' });
    remoteOkReplies();

    await searchRemoteOk();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => /Chrome\/129/.test(r.userAgent ?? ''))).toBe(true);
  });

  it('an operator strict mode still pins the configured UA over the switch', async () => {
    setEnv({ EVER_JOBS_REMOTEOK_LEGACY: 'ua', [CRAWL_ENV.USER_AGENT_MODE]: 'strict' });
    remoteOkReplies();

    await searchRemoteOk();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => r.userAgent === EVER_JOBS_DEFAULT_USER_AGENT)).toBe(true);
  });
});

// ── Welcome to the Jungle ───────────────────────────────────────────────────

/** Two pages of one hit each, so company mode walks page 0 then page 1. */
function wttjReplies(): void {
  reply = (cfg) => {
    const page = Number((JSON.parse(String(cfg.data ?? '{}')) as { page?: number }).page ?? 0);
    const id = `ref-${page}`;
    return {
      data: {
        hits: [{ objectID: id, reference: id, name: `Role ${page}`, slug: `role-${page}`, organization: { slug: 'acme', name: 'Acme' } }],
        nbPages: 2,
        nbHits: 2,
      },
    };
  };
}

async function searchWttj(extra: Partial<ScraperInputDto> = {}): Promise<void> {
  const service = createService(Site.WTTJ, new WelcomeToTheJungleService(), metadataCrawl(WelcomeToTheJungleService));
  await service.searchJobs(
    new ScraperInputDto({ siteType: [Site.WTTJ], companySlug: 'acme', resultsWanted: 2, ...extra }),
  );
}

describe('Welcome to the Jungle through JobsService (Spec 1705 × Spec 1690)', () => {
  it('a caller rateDelayMin of 0.05 s does not shorten the 0.5 s floor between index pages', async () => {
    wttjReplies();

    await searchWttj({ rateDelayMin: 0.05, rateDelayMax: 0.05 });

    expect(wire).toHaveLength(2);
    expect(wire.every((r) => r.callerMinIntervalMs === 50)).toBe(true);
    expect(grants).toHaveLength(wire.length);
    expect(grantGaps()[0]).toBeGreaterThanOrEqual(500);
  });

  it('sends the configured honest UA by default (control)', async () => {
    wttjReplies();

    await searchWttj();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => r.userAgent === EVER_JOBS_DEFAULT_USER_AGENT)).toBe(true);
  });

  it('WTTJ_USER_AGENT_MODE=browser puts the pre-1705 browser UA on the wire again', async () => {
    setEnv({ WTTJ_USER_AGENT_MODE: 'browser' });
    wttjReplies();

    await searchWttj();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => /Chrome\/129/.test(r.userAgent ?? ''))).toBe(true);
  });

  it('an operator strict mode still pins the configured UA over the switch', async () => {
    setEnv({ WTTJ_USER_AGENT_MODE: 'browser', [CRAWL_ENV.USER_AGENT_MODE]: 'strict' });
    wttjReplies();

    await searchWttj();

    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((r) => r.userAgent === EVER_JOBS_DEFAULT_USER_AGENT)).toBe(true);
  });
});

// ── Simplify ────────────────────────────────────────────────────────────────

describe('Simplify through JobsService (Spec 1694 × Spec 1690)', () => {
  it('a caller rateDelayMin of 0.05 s does not shorten the 2 s spacing of robots.txt and the feeds', async () => {
    reply = (cfg) =>
      String(cfg.url).endsWith('/robots.txt')
        ? { data: 'User-agent: *\nAllow: /\n' }
        : { data: Buffer.from('[]') };
    const service = createService(Site.SIMPLIFYJOBS, new SimplifyJobsService(), metadataCrawl(SimplifyJobsService));

    await service.searchJobs(
      new ScraperInputDto({ siteType: [Site.SIMPLIFYJOBS], searchTerm: 'engineer', rateDelayMin: 0.05, rateDelayMax: 0.05 }),
    );

    expect(wire.length).toBeGreaterThanOrEqual(2);
    expect(wire.every((r) => r.callerMinIntervalMs === 50)).toBe(true);
    expect(grants).toHaveLength(wire.length);
    expect(Math.min(...grantGaps())).toBeGreaterThanOrEqual(2000);
  });
});
