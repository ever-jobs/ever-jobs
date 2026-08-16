# Spec: 5076 — BrowserPool headful / persistent-context opt-in

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5076                               |
| Slug           | browserpool-headful-persistent-context |
| Status         | in-progress                        |
| Owner          | agent                              |
| Created        | 2026-08-04                         |
| Last updated   | 2026-08-04                         |
| Supersedes     | (none)                             |
| Related specs  | 5054                               |

## 1. Problem Statement

`BrowserPool` in `packages/common` launches a fresh, headless Playwright Chromium context per page. Cloudflare-managed sites (`jobs.gusto.com`, `desktopmetal.com`) detect this and serve an interstitial or challenge instead of the real page. Plugins that rely on a real browser (`source-ats-gusto-hosted`, `source-company-desktopmetal`) then return 0 jobs even though the board has postings.

## 2. Goals

Add an opt-in mechanism so source plugins can request a **headful, persistent-context browser** from `BrowserPool`. The default stays unchanged (ephemeral headless) so existing plugins are unaffected.

## 3. Non-Goals

- No automatic Cloudflare solving or CAPTCHA handling.
- No fetch1 coupling or `file://` cache paths.
- No changes to `ScraperInputDto` schema.
- No change to existing plugins in this PR.

## 4. Changes

1. Extend `BrowserPageOptions` with `headful?: boolean` and `userDataDir?: string`.
2. Update `BrowserPool.getPage` to route to `chromium.launchPersistentContext()` when `userDataDir` is set and/or `headful` is true.
3. Keep a backward-compatible fallback to `chromium.launch()` + `browser.newContext()` when neither option is requested.
4. If `headful` is requested in a headless environment, log a warning that a display server is needed.
5. Use the same stealth init script and proxy/UA handling in the persistent context path.

## 5. Test Plan

- Unit test that `BrowserPool.getPage` switches to `launchPersistentContext` when `userDataDir` is provided.
- Unit test that `getPage` still uses `launch` + `newContext` when neither option is set.
- Mock Chromium launch/persistent APIs to avoid needing a real browser in CI.
