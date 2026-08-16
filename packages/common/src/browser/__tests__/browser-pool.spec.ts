import 'reflect-metadata';
import { BrowserPool } from '../browser-pool';

const mockLaunch = jest.fn();
const mockLaunchPersistentContext = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
    launchPersistentContext: (...args: unknown[]) => mockLaunchPersistentContext(...args),
  },
}));

describe('BrowserPool', () => {
  const mockPage = { close: jest.fn() };

  const mockContext = {
    newPage: jest.fn().mockResolvedValue(mockPage),
    close: jest.fn().mockResolvedValue(undefined),
    pages: jest.fn().mockReturnValue([]),
    addInitScript: jest.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    isConnected: jest.fn().mockReturnValue(true),
    newContext: jest.fn().mockResolvedValue(mockContext),
    close: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLaunch.mockResolvedValue(mockBrowser);
    mockLaunchPersistentContext.mockResolvedValue(mockContext);
  });

  afterEach(async () => {
    await BrowserPool.close();
  });

  it('launches a normal headless browser by default', async () => {
    await BrowserPool.getPage();

    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ headless: expect.any(Boolean) }));
    expect(mockBrowser.newContext).toHaveBeenCalled();
    expect(mockContext.newPage).toHaveBeenCalled();
  });

  it('uses launchPersistentContext when headful is requested', async () => {
    await BrowserPool.getPage({ headful: true });

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.stringContaining('chromium-profile'),
      expect.objectContaining({ headless: false }),
    );
  });

  it('uses the provided userDataDir', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });

    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      '/tmp/test-profile',
      expect.any(Object),
    );
  });

  it('reuses an existing persistent context for the same userDataDir', async () => {
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });
    jest.clearAllMocks();
    await BrowserPool.getPage({ userDataDir: '/tmp/test-profile' });

    expect(mockLaunchPersistentContext).not.toHaveBeenCalled();
    expect(mockContext.newPage).toHaveBeenCalledTimes(1);
  });

  it('passes stealth UA and proxy to persistent context', async () => {
    const page = await BrowserPool.getPage({
      headful: true,
      stealth: true,
      proxy: 'http://proxy:8080',
    });

    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        userAgent: expect.stringContaining('Chrome'),
        proxy: { server: 'http://proxy:8080' },
        headless: false,
      }),
    );
    expect(page).toBe(mockPage);
  });
});
