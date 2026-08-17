import 'reflect-metadata';
import { join } from 'path';
import { BrowserPool } from '../browser-pool';

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

describe('BrowserPool', () => {
  let ephemeralContext: any;
  let mockBrowser: any;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EVER_JOBS_BROWSER_HEADFUL;

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

  it('passes stealth UA and proxy to the persistent context', async () => {
    await BrowserPool.getPage({ headful: true, stealth: true, proxy: 'http://proxy:8080' });

    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        userAgent: expect.stringContaining('Chrome'),
        proxy: { server: 'http://proxy:8080' },
        headless: false,
      }),
    );
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
});
