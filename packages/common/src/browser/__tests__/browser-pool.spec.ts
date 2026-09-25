import 'reflect-metadata';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  CRAWL_ENV,
  EVER_JOBS_DEFAULT_USER_AGENT,
  LEGACY_BROWSER_USER_AGENT,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  runWithScrapeContext,
} from '../../http/crawl';
import {
  BROWSER_POOL_DEFAULT_USER_AGENT,
  BrowserPool,
  isLegacyBrowserIdentity,
  redactBrowserIdentityKey,
  resolveBrowserUserAgent,
} from '../browser-pool';
import * as browserIndex from '../index';
import { USER_AGENT_POOL, VIEWPORT_POOL } from '../stealth-scripts';

const mockLaunch = jest.fn();
const mockLaunchPersistentContext = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
    launchPersistentContext: (...args: unknown[]) => mockLaunchPersistentContext(...args),
  },
}));

function makePage(): any {
  const page: any = { close: jest.fn(), isClosed: jest.fn().mockReturnValue(false) };
  page.close.mockImplementation(async () => {
    page.isClosed.mockReturnValue(true);
  });
  return page;
}

/**
 * A persistent context behaves like Playwright's: it is created with one blank
 * page already open, and it announces its own death through a `close` event.
 */
function makeContext(initialPages: any[] = [makePage()]): any {
  const handlers: Record<string, Array<() => void>> = {};
  const pages = [...initialPages];

  return {
    pages: jest.fn(() => [...pages]),
    newPage: jest.fn(async () => {
      const page = makePage();
      pages.push(page);
      return page;
    }),
    addInitScript: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, handler: () => void) => {
      (handlers[event] ??= []).push(handler);
    }),
    /** Test hook: simulate Chromium dying underneath us. */
    emitClose: () => handlers['close']?.forEach((h) => h()),
    initialPages,
  };
}

/** Every crawl-policy env var, so a developer's shell cannot leak into these tests. */
const CRAWL_ENV_KEYS: string[] = Object.values(CRAWL_ENV);
const savedCrawlEnv: Record<string, string | undefined> = {};

/** Set crawl env vars for one test and drop the memoised parse. */
function setCrawlEnv(vars: Record<string, string>): void {
  Object.assign(process.env, vars);
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
}

beforeAll(() => {
  for (const key of CRAWL_ENV_KEYS) savedCrawlEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of CRAWL_ENV_KEYS) {
    if (savedCrawlEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedCrawlEnv[key];
  }
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
});

describe('BrowserPool', () => {
  let ephemeralContext: any;
  let mockBrowser: any;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVER_JOBS_BROWSER_HEADFUL;
    for (const key of CRAWL_ENV_KEYS) delete process.env[key];
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();

    ephemeralContext = makeContext([]);
    mockBrowser = {
      isConnected: jest.fn().mockReturnValue(true),
      newContext: jest.fn().mockResolvedValue(ephemeralContext),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockLaunch.mockResolvedValue(mockBrowser);
    mockLaunchPersistentContext.mockImplementation(async () => makeContext());
  });

  afterEach(async () => {
    await BrowserPool.close();
    delete process.env.EVER_JOBS_BROWSER_HEADFUL;
  });

  /** Directory passed to the Nth `launchPersistentContext` call. */
  const profileDirOfCall = (n = 0): string => mockLaunchPersistentContext.mock.calls[n][0];

  it('launches a normal headless browser by default', async () => {
    await BrowserPool.getPage();

    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ headless: expect.any(Boolean) }));
    expect(mockBrowser.newContext).toHaveBeenCalled();
    expect(mockLaunchPersistentContext).not.toHaveBeenCalled();
  });

  it('uses launchPersistentContext when headful is requested', async () => {
    await BrowserPool.getPage({ headful: true });

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.stringContaining('chromium-profile'),
      expect.objectContaining({ headless: false }),
    );
  });

  it('nests each profile under the configured userDataDir root', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });

    const root = join('/tmp/test-profile');
    const dir = profileDirOfCall();
    expect(dir.startsWith(root)).toBe(true);
    // Nested, not the bare root — the root holds one profile per identity.
    expect(dir).not.toBe(root);
  });

  it('reuses an existing persistent context for the same identity', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
  });

  /**
   * The defect this replaces: contexts were cached on `userDataDir` alone, so
   * the second caller's proxy was dropped and its traffic silently egressed
   * through the first caller's route.
   */
  it('does not reuse a context across different proxies', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/p', proxy: 'http://a:8080' });
    await BrowserPool.getPage({ userDataDir: '/tmp/p', proxy: 'http://b:8080' });

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
    expect(profileDirOfCall(0)).not.toBe(profileDirOfCall(1));
    expect(mockLaunchPersistentContext.mock.calls[0][1]).toMatchObject({
      proxy: { server: 'http://a:8080' },
    });
    expect(mockLaunchPersistentContext.mock.calls[1][1]).toMatchObject({
      proxy: { server: 'http://b:8080' },
    });
  });

  it('gives a stealth request its own profile, separate from a plain one', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/p' });
    await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
    expect(profileDirOfCall(0)).not.toBe(profileDirOfCall(1));
  });

  it('picks the same profile directory again for an identical identity', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/p', proxy: 'http://a:8080' });
    await BrowserPool.close();
    await BrowserPool.getPage({ userDataDir: '/tmp/p', proxy: 'http://a:8080' });

    expect(profileDirOfCall(0)).toBe(profileDirOfCall(1));
  });

  /**
   * Playwright replays every registered init script into each new page, so
   * re-registering per `getPage()` against a long-lived context grew without
   * bound.
   */
  it('registers the stealth init script once per persistent context', async () => {
    await BrowserPool.getPage({ headful: true, stealth: true });
    await BrowserPool.getPage({ headful: true, stealth: true });
    await BrowserPool.getPage({ headful: true, stealth: true });

    const context = await mockLaunchPersistentContext.mock.results[0].value;
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
  });

  it('disposes the blank page that launchPersistentContext opens', async () => {
    await BrowserPool.getPage({ headful: true });

    const context = await mockLaunchPersistentContext.mock.results[0].value;
    expect(context.initialPages[0].close).toHaveBeenCalledTimes(1);
  });

  it('does not close the blank page again on the next call', async () => {
    await BrowserPool.getPage({ headful: true });
    await BrowserPool.getPage({ headful: true });

    const context = await mockLaunchPersistentContext.mock.results[0].value;
    expect(context.initialPages[0].close).toHaveBeenCalledTimes(1);
  });

  /**
   * The defect this replaces: liveness was `context.pages().length >= 0`, which
   * is true for a dead context, so one crash poisoned every later headful call
   * until the process restarted.
   */
  it('relaunches after a persistent context closes underneath it', async () => {
    await BrowserPool.getPage({ headful: true });
    const first = await mockLaunchPersistentContext.mock.results[0].value;

    first.emitClose();
    await BrowserPool.getPage({ headful: true });

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('retries a launch that failed instead of caching the rejection', async () => {
    mockLaunchPersistentContext.mockRejectedValueOnce(new Error('Executable doesn\'t exist'));

    await expect(BrowserPool.getPage({ headful: true })).rejects.toThrow('Executable doesn\'t exist');
    await expect(BrowserPool.getPage({ headful: true })).resolves.toBeDefined();

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight launch between concurrent callers', async () => {
    await Promise.all([
      BrowserPool.getPage({ headful: true }),
      BrowserPool.getPage({ headful: true }),
      BrowserPool.getPage({ headful: true }),
    ]);

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
  });

  /**
   * Spec 1690: under the default (`polite`, `identify`) policy a stealth page
   * keeps its JS patches but sends the honest Ever Jobs UA, not a pool Chrome UA.
   */
  it('passes the configured UA and proxy to a stealth persistent context', async () => {
    await BrowserPool.getPage({ headful: true, stealth: true, proxy: 'http://proxy:8080' });

    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        userAgent: EVER_JOBS_DEFAULT_USER_AGENT,
        proxy: { server: 'http://proxy:8080' },
        headless: false,
      }),
    );
    const context = await mockLaunchPersistentContext.mock.results[0].value;
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
  });

  it('passes a stealth pool UA and proxy to the persistent context in plugin mode', async () => {
    setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });

    await BrowserPool.getPage({ headful: true, stealth: true, proxy: 'http://proxy:8080' });

    const opts = mockLaunchPersistentContext.mock.calls[0][1];
    expect(USER_AGENT_POOL).toContain(opts.userAgent);
    expect(opts.userAgent).toContain('Chrome');
    expect(opts).toMatchObject({ proxy: { server: 'http://proxy:8080' }, headless: false });
  });

  describe('EVER_JOBS_BROWSER_HEADFUL kill switch', () => {
    it('falls back to headless when set to false', async () => {
      process.env.EVER_JOBS_BROWSER_HEADFUL = 'false';

      await BrowserPool.getPage({ headful: true });

      expect(mockLaunchPersistentContext).not.toHaveBeenCalled();
      expect(mockLaunch).toHaveBeenCalled();
      expect(mockBrowser.newContext).toHaveBeenCalled();
    });

    it('still honours an explicit userDataDir while headful is disabled', async () => {
      process.env.EVER_JOBS_BROWSER_HEADFUL = 'false';

      await BrowserPool.getPage({ headful: true, userDataDir: '/tmp/p' });

      expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headless: expect.any(Boolean) }),
      );
      expect(mockLaunchPersistentContext.mock.calls[0][1].headless).not.toBe(false);
    });

    it('honours headful when the variable is unset', async () => {
      await BrowserPool.getPage({ headful: true });

      expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headless: false }),
      );
    });
  });

  // ── Spec 1690 §4.2: the context UA follows the crawl policy ─────────────────

  /** Context options passed to the Nth ephemeral `browser.newContext` call. */
  const ephemeralOpts = (n = 0): any => mockBrowser.newContext.mock.calls[n][0];
  /** Context options passed to the Nth `launchPersistentContext` call. */
  const persistentOpts = (n = 0): any => mockLaunchPersistentContext.mock.calls[n][1];
  /** The profile directory BrowserPool used before Spec 1690 for an identity key. */
  const preSpecProfileDir = (root: string, identityKey: string): string =>
    join(root, createHash('sha1').update(identityKey).digest('hex').slice(0, 8));

  const USAJOBS_OPT_IN = {
    userAgentMode: 'plugin' as const,
    userAgentReason: 'API requires the registered e-mail as User-Agent',
  };

  describe('crawl-policy identity (default polite / identify)', () => {
    it('sends the configured Ever Jobs UA on a plain page', async () => {
      await BrowserPool.getPage();

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('sends the configured UA on a stealth page but keeps its patches and viewport rotation', async () => {
      await BrowserPool.getPage({ stealth: true });

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(VIEWPORT_POOL).toContainEqual(ephemeralOpts().viewport);
      expect(ephemeralContext.addInitScript).toHaveBeenCalledTimes(1);
    });

    it('does not register the stealth script on a plain page', async () => {
      await BrowserPool.getPage();

      expect(ephemeralOpts().viewport).toEqual({ width: 1440, height: 900 });
      expect(ephemeralContext.addInitScript).not.toHaveBeenCalled();
    });

    it('inserts EVER_JOBS_CRAWL_CONTACT into the default UA', async () => {
      setCrawlEnv({ [CRAWL_ENV.CONTACT]: 'ops@acme.example' });

      await BrowserPool.getPage();

      expect(ephemeralOpts().userAgent).toBe(
        EVER_JOBS_DEFAULT_USER_AGENT.replace(/\)$/, '; ops@acme.example)'),
      );
    });

    it('uses EVER_JOBS_CRAWL_USER_AGENT verbatim', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT]: 'AcmeBot/2.0 (+https://acme.example/bot)' });

      await BrowserPool.getPage({ stealth: true });

      expect(ephemeralOpts().userAgent).toBe('AcmeBot/2.0 (+https://acme.example/bot)');
    });

    it('expands the "browser" keyword to the pre-1690 Chrome UA', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT]: 'browser' });

      await BrowserPool.getPage();

      expect(ephemeralOpts().userAgent).toBe(LEGACY_BROWSER_USER_AGENT);
    });

    it('ignores a declared UA when nothing lets the plugin choose', async () => {
      await BrowserPool.getPage({ userAgent: 'Declared/1.0', stealth: true });

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('ignores a declared UA under EVER_JOBS_CRAWL_USER_AGENT_MODE=strict', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'strict' });

      await BrowserPool.getPage({ userAgent: 'Declared/1.0' });

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });
  });

  describe('plugin mode (EVER_JOBS_CRAWL_USER_AGENT_MODE=plugin)', () => {
    beforeEach(() => setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' }));

    it('uses the declared UA, stealth or not', async () => {
      await BrowserPool.getPage({ userAgent: 'Declared/1.0' });
      await BrowserPool.getPage({ userAgent: 'Declared/2.0', stealth: true });

      expect(ephemeralOpts(0).userAgent).toBe('Declared/1.0');
      expect(ephemeralOpts(1).userAgent).toBe('Declared/2.0');
    });

    it('falls back to USER_AGENT_POOL[0] on a plain page with no declared UA (pre-1690)', async () => {
      await BrowserPool.getPage();

      expect(ephemeralOpts().userAgent).toBe(USER_AGENT_POOL[0]);
    });

    it('picks a random pool UA on a stealth page with no declared UA (pre-1690)', async () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.99);
      try {
        await BrowserPool.getPage({ stealth: true });
      } finally {
        random.mockRestore();
      }

      expect(ephemeralOpts().userAgent).toBe(USER_AGENT_POOL[USER_AGENT_POOL.length - 1]);
    });

    it('strips control characters from a declared UA and treats a blank one as undeclared', async () => {
      await BrowserPool.getPage({ userAgent: 'Bad\r\nInjected: 1' });
      await BrowserPool.getPage({ userAgent: '   ' });

      expect(ephemeralOpts(0).userAgent).toBe('BadInjected: 1');
      expect(ephemeralOpts(1).userAgent).toBe(USER_AGENT_POOL[0]);
    });
  });

  describe('plugin manifest opt-in (scrape context)', () => {
    const getPageAs = (plugin: object, opts: object) =>
      runWithScrapeContext({ site: 'usajobs', plugin }, () => BrowserPool.getPage(opts));

    it('uses the declared UA under identify when the manifest opts in', async () => {
      await getPageAs(USAJOBS_OPT_IN, { userAgent: 'me@example.gov' });

      expect(ephemeralOpts().userAgent).toBe('me@example.gov');
    });

    it('lets an opted-in stealth page keep a random pool UA when it declares none', async () => {
      await getPageAs(USAJOBS_OPT_IN, { stealth: true });

      expect(USER_AGENT_POOL).toContain(ephemeralOpts().userAgent);
    });

    it('drops the opt-in under EVER_JOBS_CRAWL_USER_AGENT_MODE=strict', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'strict' });

      await getPageAs(USAJOBS_OPT_IN, { userAgent: 'me@example.gov', stealth: true });

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('lets an operator site policy override the opt-in', async () => {
      setCrawlEnv({
        [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { usajobs: { userAgentMode: 'identify' } } }),
      });

      await getPageAs(USAJOBS_OPT_IN, { userAgent: 'me@example.gov' });

      expect(ephemeralOpts().userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });
  });

  describe('legacy preset (EVER_JOBS_CRAWL_PRESET=legacy)', () => {
    beforeEach(() => setCrawlEnv({ [CRAWL_ENV.PRESET]: 'legacy' }));

    it('sends the Chrome pool UA (USER_AGENT_POOL[0]) on a plain page, exactly as before', async () => {
      await BrowserPool.getPage();

      expect(LEGACY_BROWSER_USER_AGENT).toBe(USER_AGENT_POOL[0]);
      expect(ephemeralOpts().userAgent).toBe(USER_AGENT_POOL[0]);
    });

    it('gives a stealth page a random pool UA, as before 1690 (a declared UA is ignored: pre-1690 pages had none)', async () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.99);
      try {
        await BrowserPool.getPage({ stealth: true, userAgent: 'Declared/1.0' });
      } finally {
        random.mockRestore();
      }

      expect(ephemeralOpts().userAgent).toBe(USER_AGENT_POOL[USER_AGENT_POOL.length - 1]);
    });

    it('rotates the stealth UA across pages (20 pages, more than one UA)', async () => {
      for (let i = 0; i < 20; i++) await BrowserPool.getPage({ stealth: true });

      const uas = new Set(mockBrowser.newContext.mock.calls.map((c: any[]) => c[0].userAgent));
      expect(uas.size).toBeGreaterThan(1);
      for (const ua of uas) expect(USER_AGENT_POOL).toContain(ua);
    });

    it('keeps the pre-1690 profile directory (and context reuse) for stealth persistent pages', async () => {
      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
      expect(profileDirOfCall()).toBe(preSpecProfileDir('/tmp/p', '|false|true|'));
    });

    it('an operator-set UA (EVER_JOBS_CRAWL_USER_AGENT) is not the legacy identity: it is sent as configured', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT]: 'OpsBot/1.0' });
      await BrowserPool.getPage({ stealth: true });

      expect(ephemeralOpts().userAgent).toBe('OpsBot/1.0');
    });

    it('with mode=plugin reproduces the pre-1690 stealth rotation', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.4);
      try {
        await BrowserPool.getPage({ stealth: true });
      } finally {
        random.mockRestore();
      }

      expect(ephemeralOpts().userAgent).toBe(USER_AGENT_POOL[Math.floor(0.4 * USER_AGENT_POOL.length)]);
    });

    it('keeps the pre-1690 profile directory for a plain persistent page', async () => {
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });

      expect(profileDirOfCall()).toBe(preSpecProfileDir('/tmp/p', '|false|false|'));
      expect(persistentOpts().userAgent).toBe(USER_AGENT_POOL[0]);
    });
  });

  describe('operator, caller and per-page layers', () => {
    it('applies an operator host policy only when the page names its host', async () => {
      setCrawlEnv({
        [CRAWL_ENV.POLICIES]: JSON.stringify({ hosts: { '*.example.com': { userAgent: 'HostBot/1.0' } } }),
      });

      await BrowserPool.getPage({ host: 'https://jobs.example.com/careers?page=2' });
      await BrowserPool.getPage({ host: 'jobs.example.com' });
      await BrowserPool.getPage();

      expect(ephemeralOpts(0).userAgent).toBe('HostBot/1.0');
      expect(ephemeralOpts(1).userAgent).toBe('HostBot/1.0');
      expect(ephemeralOpts(2).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('applies an operator site policy from the scrape context', async () => {
      setCrawlEnv({ [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { dice: { userAgentMode: 'plugin' } } }) });

      await runWithScrapeContext({ site: 'dice' }, () => BrowserPool.getPage());
      await BrowserPool.getPage();

      expect(ephemeralOpts(0).userAgent).toBe(USER_AGENT_POOL[0]);
      expect(ephemeralOpts(1).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
    });

    it('sends a search caller UA from the scrape context', async () => {
      await runWithScrapeContext({ site: 'dice', caller: { userAgent: 'CallerBot/1.0' } }, () =>
        BrowserPool.getPage({ userAgent: 'Declared/1.0' }),
      );

      expect(ephemeralOpts().userAgent).toBe('CallerBot/1.0');
    });

    it('honours per-page crawl options as the plugin layer; a plugin-layer UA is a declaration', async () => {
      await BrowserPool.getPage({ crawl: { userAgent: 'PageBot/1.0' } });
      await BrowserPool.getPage({ crawl: { userAgentMode: 'plugin' }, userAgent: 'Declared/1.0' });
      await BrowserPool.getPage({ crawl: { userAgentMode: 'plugin', userAgent: 'PageBot/1.0' } });

      expect(ephemeralOpts(0).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(ephemeralOpts(1).userAgent).toBe('Declared/1.0');
      expect(ephemeralOpts(2).userAgent).toBe('PageBot/1.0');
    });

    it('a manifest userAgent is declared too: sent only with the manifest opt-in', async () => {
      await runWithScrapeContext({ site: 'x', plugin: { userAgent: 'Manifest/1' } }, () => BrowserPool.getPage());
      await runWithScrapeContext(
        { site: 'x', plugin: { userAgent: 'Manifest/1', userAgentMode: 'plugin', userAgentReason: 'r' } },
        () => BrowserPool.getPage(),
      );

      expect(ephemeralOpts(0).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(ephemeralOpts(1).userAgent).toBe('Manifest/1');
    });
  });

  describe('From header (EVER_JOBS_CRAWL_FROM)', () => {
    it('sends From on every request of the context when configured', async () => {
      setCrawlEnv({ [CRAWL_ENV.FROM]: 'ops@acme.example' });

      await BrowserPool.getPage();
      await BrowserPool.getPage({ headful: true });

      expect(ephemeralOpts().extraHTTPHeaders).toEqual({ From: 'ops@acme.example' });
      expect(persistentOpts().extraHTTPHeaders).toEqual({ From: 'ops@acme.example' });
    });

    it('sends no extra headers when From is not configured', async () => {
      await BrowserPool.getPage();

      expect(ephemeralOpts().extraHTTPHeaders).toBeUndefined();
    });

    it('does not reuse a persistent context across From values', async () => {
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });
      setCrawlEnv({ [CRAWL_ENV.FROM]: 'ops@acme.example' });
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
      expect(profileDirOfCall(0)).not.toBe(profileDirOfCall(1));
    });
  });

  describe('persistent-context identity includes the UA', () => {
    it('does not reuse a context across declared UAs', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });

      await BrowserPool.getPage({ userDataDir: '/tmp/p', userAgent: 'A/1.0' });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', userAgent: 'B/1.0' });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', userAgent: 'A/1.0' });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
      expect(profileDirOfCall(0)).not.toBe(profileDirOfCall(1));
      expect(persistentOpts(0).userAgent).toBe('A/1.0');
      expect(persistentOpts(1).userAgent).toBe('B/1.0');
    });

    it('relaunches when the configured UA changes', async () => {
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT]: 'Other/1.0' });
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
      expect(persistentOpts(0).userAgent).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
      expect(persistentOpts(1).userAgent).toBe('Other/1.0');
    });

    it('gives the honest UA its own profile, apart from the pre-1690 one', async () => {
      await BrowserPool.getPage({ userDataDir: '/tmp/p' });

      expect(profileDirOfCall()).not.toBe(preSpecProfileDir('/tmp/p', '|false|false|'));
      expect(profileDirOfCall().startsWith(join('/tmp/p'))).toBe(true);
    });

    it('reuses one context for repeated stealth pages whose pool UA rotates', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });

      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
      // The rotating pool UA is not part of the identity: same directory as before 1690.
      expect(profileDirOfCall()).toBe(preSpecProfileDir('/tmp/p', '|false|true|'));
    });

    it('does not share a context between a pinned stealth UA and a rotating one', async () => {
      setCrawlEnv({ [CRAWL_ENV.USER_AGENT_MODE]: 'plugin' });

      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true });
      await BrowserPool.getPage({ userDataDir: '/tmp/p', stealth: true, userAgent: USER_AGENT_POOL[2] });

      expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
      expect(persistentOpts(1).userAgent).toBe(USER_AGENT_POOL[2]);
    });
  });

  describe('scrape deadline abort (Spec 1690 §4.6)', () => {
    it('an already-aborted scrape opens no page', async () => {
      const controller = new AbortController();
      controller.abort(Object.assign(new Error('deadline'), { name: 'AbortError' }));

      await expect(runWithScrapeContext({ site: 'x', signal: controller.signal }, () => BrowserPool.getPage())).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(mockBrowser.newContext).not.toHaveBeenCalled();
    });

    it('closes an ephemeral page\'s context when the scrape aborts later', async () => {
      const controller = new AbortController();
      await runWithScrapeContext({ site: 'x', signal: controller.signal }, () => BrowserPool.getPage());
      expect(ephemeralContext.close).not.toHaveBeenCalled();

      controller.abort();
      await Promise.resolve();

      expect(ephemeralContext.close).toHaveBeenCalledTimes(1);
    });

    it('closes only the page (not the shared persistent context) on abort', async () => {
      const controller = new AbortController();
      const page = await runWithScrapeContext({ site: 'x', signal: controller.signal }, () =>
        BrowserPool.getPage({ userDataDir: '/tmp/p' }),
      );
      const context = await mockLaunchPersistentContext.mock.results[0].value;

      controller.abort();
      await Promise.resolve();

      expect(page.close).toHaveBeenCalled();
      expect(context.close).not.toHaveBeenCalled();
    });

    it('does nothing without a scrape signal', async () => {
      const page = await BrowserPool.getPage();
      expect(page.close).not.toHaveBeenCalled();
      expect(ephemeralContext.close).not.toHaveBeenCalled();
    });
  });

  describe('logs never carry proxy credentials', () => {
    it('redactBrowserIdentityKey hides user:pass in a proxy URL, with or without a scheme', () => {
      expect(redactBrowserIdentityKey('/tmp/p|true|false|http://user:secret@proxy.example:8080')).toBe(
        '/tmp/p|true|false|http://***@proxy.example:8080',
      );
      expect(redactBrowserIdentityKey('/tmp/p|true|false|user:secret@proxy.example:8080|ua=X/1')).toBe(
        '/tmp/p|true|false|***@proxy.example:8080|ua=X/1',
      );
      expect(redactBrowserIdentityKey('/tmp/p|false|false|')).toBe('/tmp/p|false|false|');
    });

    it('close() logs the redacted key', async () => {
      const log = jest.spyOn((BrowserPool as any).logger, 'log').mockImplementation(() => undefined);
      await BrowserPool.getPage({ userDataDir: '/tmp/p', proxy: 'http://user:secret@proxy.example:8080' });
      await BrowserPool.close();

      const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toContain('***@proxy.example:8080');
      expect(lines).not.toContain('secret');
    });
  });

  describe('resolveBrowserUserAgent', () => {
    const configured = 'Configured/1.0';

    it('legacy → the pre-1690 pool whatever the mode and declaration', () => {
      const pickLast = (pool: readonly string[]) => pool[pool.length - 1];
      const policy = { userAgent: LEGACY_BROWSER_USER_AGENT, userAgentMode: 'strict' as const };
      expect(resolveBrowserUserAgent(policy, { stealth: true, legacy: true, userAgent: 'D/1' }, pickLast)).toEqual({
        userAgent: USER_AGENT_POOL[USER_AGENT_POOL.length - 1],
        source: 'pool',
        rotating: true,
      });
      expect(resolveBrowserUserAgent(policy, { legacy: true })).toEqual({
        userAgent: USER_AGENT_POOL[0],
        source: 'pool',
        rotating: false,
      });
    });

    it('isLegacyBrowserIdentity: only the legacy preset\'s own mode and UA', () => {
      const own = { userAgentMode: 'strict' as const, provenance: { userAgentMode: 'preset' as const, userAgent: 'preset' as const } };
      expect(isLegacyBrowserIdentity(own, 'legacy')).toBe(true);
      expect(isLegacyBrowserIdentity(own, 'polite')).toBe(false);
      expect(isLegacyBrowserIdentity({ ...own, provenance: { ...own.provenance, userAgent: 'env-global' as const } }, 'legacy')).toBe(false);
      expect(isLegacyBrowserIdentity({ ...own, provenance: { ...own.provenance, userAgentMode: 'caller' as const } }, 'legacy')).toBe(false);
    });
    const pickLast = (pool: readonly string[]) => pool[pool.length - 1];

    it.each(['identify', 'strict'] as const)('%s → the configured UA, whatever is declared', (mode) => {
      for (const stealth of [false, true]) {
        expect(
          resolveBrowserUserAgent({ userAgent: configured, userAgentMode: mode }, { userAgent: 'D/1', stealth }, pickLast),
        ).toEqual({ userAgent: configured, source: 'configured', rotating: false });
      }
    });

    it('plugin → the declared UA', () => {
      expect(
        resolveBrowserUserAgent({ userAgent: configured, userAgentMode: 'plugin' }, { userAgent: ' D/1 ', stealth: true }),
      ).toEqual({ userAgent: 'D/1', source: 'declared', rotating: false });
    });

    it('plugin, stealth, nothing declared → a rotating pool pick', () => {
      expect(
        resolveBrowserUserAgent({ userAgent: configured, userAgentMode: 'plugin' }, { stealth: true }, pickLast),
      ).toEqual({ userAgent: USER_AGENT_POOL[USER_AGENT_POOL.length - 1], source: 'pool', rotating: true });
    });

    it('plugin, plain page, nothing declared → USER_AGENT_POOL[0]', () => {
      expect(resolveBrowserUserAgent({ userAgent: configured, userAgentMode: 'plugin' })).toEqual({
        userAgent: USER_AGENT_POOL[0],
        source: 'pool',
        rotating: false,
      });
    });

    it('falls back to the Ever Jobs default when the configured UA is blank', () => {
      expect(resolveBrowserUserAgent({ userAgent: ' ', userAgentMode: 'identify' }).userAgent).toBe(
        EVER_JOBS_DEFAULT_USER_AGENT,
      );
    });

    it('treats an unknown mode like identify (configured UA)', () => {
      expect(
        resolveBrowserUserAgent({ userAgent: configured, userAgentMode: 'bogus' as never }, { userAgent: 'D/1' })
          .userAgent,
      ).toBe(configured);
    });

    it('keeps the pool default equal to the legacy browser UA', () => {
      expect(BROWSER_POOL_DEFAULT_USER_AGENT).toBe(USER_AGENT_POOL[0]);
      expect(BROWSER_POOL_DEFAULT_USER_AGENT).toBe(LEGACY_BROWSER_USER_AGENT);
    });

    it('is exported from the browser barrel', () => {
      expect(browserIndex.resolveBrowserUserAgent).toBe(resolveBrowserUserAgent);
      expect(browserIndex.BROWSER_POOL_DEFAULT_USER_AGENT).toBe(BROWSER_POOL_DEFAULT_USER_AGENT);
      expect(browserIndex.BrowserPool).toBe(BrowserPool);
    });
  });
});
