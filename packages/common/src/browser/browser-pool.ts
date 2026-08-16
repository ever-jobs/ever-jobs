import { Logger } from '@nestjs/common';
import type {
  Browser,
  BrowserContext,
  Page,
  LaunchOptions,
  BrowserContextOptions,
} from 'playwright';
import { homedir } from 'os';
import { join } from 'path';
import { STEALTH_INIT_SCRIPT, USER_AGENT_POOL, VIEWPORT_POOL } from './stealth-scripts';

/** Options passed to `BrowserPool.getPage()`. */
export interface BrowserPageOptions {
  /** Proxy server URL (e.g. `http://proxy:8080` or `socks5://proxy:1080`). */
  proxy?: string;
  /** Navigation timeout in seconds (used by the caller, not the pool). */
  timeout?: number;
  /**
   * Enable stealth mode for anti-bot evasion.
   * When true, injects scripts to mask webdriver detection, randomizes
   * UA/viewport, and patches browser fingerprinting APIs.
   * Default: false (backwards-compatible).
   */
  stealth?: boolean;
  /**
   * Use a headful (visible) browser instead of the default headless Chromium.
   * Useful for Cloudflare or other bot-detection that rejects headless contexts.
   */
  headful?: boolean;
  /**
   * Persistent context profile directory. When omitted and `headful` is true,
   * a default directory under the user's cache is used.
   */
  userDataDir?: string;
}

/**
 * Shared singleton browser pool for headless Chromium scraping.
 *
 * Usage:
 *   const page = await BrowserPool.getPage();
 *   try { ... } finally { await page.close(); }
 *
 * For anti-bot protected sites:
 *   const page = await BrowserPool.getPage({ stealth: true, proxy, headful: true });
 *
 * Call `BrowserPool.close()` on app shutdown (e.g. `onModuleDestroy`).
 */
export class BrowserPool {
  private static browser: Browser | null = null;
  private static launching: Promise<Browser> | null = null;
  private static readonly persistentContexts: Map<string, BrowserContext> = new Map();
  private static readonly persistentLaunching: Map<string, Promise<BrowserContext>> = new Map();
  private static readonly logger = new Logger(BrowserPool.name);

  /** Default Chromium launch options. */
  private static readonly DEFAULT_OPTS: LaunchOptions = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };

  /** Default persistent context profile directory. */
  private static get defaultUserDataDir(): string {
    return process.env.PLAYWRIGHT_USER_DATA_DIR ?? join(homedir(), '.cache', 'ever-jobs', 'chromium-profile');
  }

  /** Default (non-stealth) User-Agent string. */
  private static readonly DEFAULT_USER_AGENT = USER_AGENT_POOL[0];

  /** Pick a random element from an array. */
  private static pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Get (or lazily launch) a shared Chromium browser instance.
   */
  static async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Prevent multiple concurrent launches
    if (this.launching) return this.launching;

    this.launching = (async () => {
      try {
        this.logger.log('Launching headless Chromium…');
        // Dynamic import — playwright may not be installed in all environments
        const { chromium } = await import('playwright');
        const browser = await chromium.launch(this.DEFAULT_OPTS);
        this.browser = browser;
        this.logger.log('Chromium launched');
        return browser;
      } catch (err) {
        // Reset the guard so subsequent calls can retry the launch
        this.launching = null;
        throw err;
      }
    })();

    return this.launching;
  }

  /**
   * Get (or lazily launch) a persistent Chromium context backed by `userDataDir`.
   */
  static async getPersistentContext(
    userDataDir: string,
    headful: boolean,
    ctxOpts: BrowserContextOptions,
  ): Promise<BrowserContext> {
    const existing = this.persistentContexts.get(userDataDir);
    if (existing && this.isContextConnected(existing)) return existing;

    const launching = this.persistentLaunching.get(userDataDir);
    if (launching) return launching;

    const promise = (async () => {
      try {
        this.logger.log(`Launching persistent Chromium context (headful=${headful}) at ${userDataDir}…`);
        const { chromium } = await import('playwright');
        const context = await chromium.launchPersistentContext(userDataDir, {
          ...this.DEFAULT_OPTS,
          ...ctxOpts,
          headless: headful ? false : this.DEFAULT_OPTS.headless,
        });
        this.persistentContexts.set(userDataDir, context);
        this.logger.log('Persistent Chromium context launched');
        return context;
      } catch (err) {
        this.persistentLaunching.delete(userDataDir);
        throw err;
      }
    })();

    this.persistentLaunching.set(userDataDir, promise);
    return promise;
  }

  /**
   * Create a fresh page with configurable stealth level.
   * The caller is responsible for closing the page when done.
   *
   * @param opts.proxy      — route all traffic through this proxy server
   * @param opts.stealth    — enable anti-bot evasion (UA/viewport rotation, JS patches)
   * @param opts.headful    — launch a headful persistent context
   * @param opts.userDataDir — persistent context profile directory
   */
  static async getPage(opts?: BrowserPageOptions): Promise<Page> {
    const stealth = opts?.stealth ?? false;
    const headful = opts?.headful ?? false;
    const wantsPersistent = headful || !!opts?.userDataDir;

    const ctxOpts: BrowserContextOptions = {
      userAgent: stealth ? this.pick(USER_AGENT_POOL) : this.DEFAULT_USER_AGENT,
      viewport: stealth ? this.pick(VIEWPORT_POOL) : { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      javaScriptEnabled: true,
    };

    if (opts?.proxy) {
      ctxOpts.proxy = { server: opts.proxy };
    }

    if (wantsPersistent) {
      const userDataDir = opts?.userDataDir ?? this.defaultUserDataDir;
      const context = await this.getPersistentContext(userDataDir, headful, ctxOpts);
      await this.applyStealthToContext(context, stealth);
      return context.newPage();
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext(ctxOpts);
    await this.applyStealthToContext(context, stealth);
    return context.newPage();
  }

  /**
   * Gracefully shut down the browser and all persistent contexts.
   * Safe to call multiple times.
   */
  static async close(): Promise<void> {
    for (const [userDataDir, context] of this.persistentContexts) {
      this.logger.log(`Closing persistent Chromium context ${userDataDir}…`);
      await context.close().catch(() => {});
    }
    this.persistentContexts.clear();
    this.persistentLaunching.clear();
    this.launching = null;

    if (this.browser) {
      this.logger.log('Closing Chromium…');
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** Apply the shared stealth init script to a context if requested. */
  private static async applyStealthToContext(context: BrowserContext, stealth: boolean): Promise<void> {
    if (stealth) {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }
  }

  /** Best-effort check that a persistent context is still usable. */
  private static isContextConnected(context: BrowserContext): boolean {
    try {
      // BrowserContext does not expose isConnected; ask for pages and swallow failure.
      return context.pages().length >= 0;
    } catch {
      return false;
    }
  }
}
