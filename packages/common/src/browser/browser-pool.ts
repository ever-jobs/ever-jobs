import { Logger } from '@nestjs/common';
import type { Browser, Page, LaunchOptions, BrowserContextOptions } from 'playwright';

/** Options passed to `BrowserPool.getPage()`. */
export interface BrowserPageOptions {
  /** Proxy server URL (e.g. `http://proxy:8080` or `socks5://proxy:1080`). */
  proxy?: string;
  /** Navigation timeout in seconds (used by the caller, not the pool). */
  timeout?: number;
}

/**
 * Shared singleton browser pool for headless Chromium scraping.
 *
 * Usage:
 *   const page = await BrowserPool.getPage();
 *   try { ... } finally { await page.close(); }
 *
 * Call `BrowserPool.close()` on app shutdown (e.g. `onModuleDestroy`).
 */
export class BrowserPool {
  private static browser: Browser | null = null;
  private static launching: Promise<Browser> | null = null;
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

  /** User-Agent string used for every new page. */
  private static readonly USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
   * Create a fresh page with stealth-like defaults.
   * The caller is responsible for closing the page when done.
   *
   * @param opts.proxy  — route all traffic through this proxy server
   */
  static async getPage(opts?: BrowserPageOptions): Promise<Page> {
    const browser = await this.getBrowser();
    const ctxOpts: BrowserContextOptions = {
      userAgent: this.USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      javaScriptEnabled: true,
    };

    if (opts?.proxy) {
      ctxOpts.proxy = { server: opts.proxy };
    }

    const context = await browser.newContext(ctxOpts);
    return context.newPage();
  }

  /**
   * Gracefully shut down the browser.
   * Safe to call multiple times.
   */
  static async close(): Promise<void> {
    if (this.browser) {
      this.logger.log('Closing Chromium…');
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
