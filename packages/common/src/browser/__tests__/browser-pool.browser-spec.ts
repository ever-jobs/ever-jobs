import 'reflect-metadata';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Page } from 'playwright';
import { BrowserPool } from '../browser-pool';

/**
 * Real-browser smoke test for {@link BrowserPool} — no mocks, no network.
 *
 * Opt-in: the `*.browser-spec.ts` suffix is outside jest's default
 * `testMatch`, so plain `jest` and CI never pick it up (CI runners have no
 * Chromium). Run it with `npm run test:browser`.
 *
 * It catches the failure mode where Playwright is installed but the Chromium
 * build it expects is not (e.g. after a Playwright upgrade), which otherwise
 * surfaces only as browser-backed sources silently returning zero jobs.
 */

/** Close a pool page together with the ephemeral context it was created in. */
async function closePage(page: Page): Promise<void> {
  const context = page.context();
  await page.close().catch(() => {});
  await context.close().catch(() => {});
}

describe('BrowserPool (real Chromium)', () => {
  afterAll(async () => {
    await BrowserPool.close();
  });

  it('has the Chromium build this Playwright version expects', async () => {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();

    if (!existsSync(executable)) {
      throw new Error(
        `Chromium for this Playwright version is not installed (expected ${executable}). ` +
          'Run: npx playwright install chromium',
      );
    }
  });

  it('launches headless Chromium, renders HTML and runs page JavaScript', async () => {
    const page = await BrowserPool.getPage();
    try {
      await page.setContent(
        '<h1 id="title">ever-jobs</h1>' +
          '<script>document.getElementById("title").dataset.sum = String(1 + 1);</script>',
      );

      expect(await page.textContent('#title')).toBe('ever-jobs');
      expect(await page.getAttribute('#title', 'data-sum')).toBe('2');
    } finally {
      await closePage(page);
    }
  });

  it('launches a stealth persistent-profile context', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'ever-jobs-browser-'));
    try {
      const page = await BrowserPool.getPage({ stealth: true, userDataDir: profileRoot });
      await page.setContent('<p id="ok">ok</p>');

      expect(await page.textContent('#ok')).toBe('ok');
      // String form: the base tsconfig has no DOM lib for a typed callback.
      expect(await page.evaluate('navigator.webdriver')).toBeFalsy();

      await page.close();
    } finally {
      // Persistent contexts are cached by the pool; close them before
      // deleting the profile directory Chromium holds a lock on.
      await BrowserPool.close();
      rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
