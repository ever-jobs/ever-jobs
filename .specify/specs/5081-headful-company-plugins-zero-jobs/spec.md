# Spec: 5081 — Headful browser for company plugins blocked on Cloudflare/Wix

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5081                               |
| Slug           | headful-company-plugins-zero-jobs  |
| Status         | in-progress                        |
| Owner          | agent                              |
| Created        | 2026-08-05                         |
| Last updated   | 2026-08-05                         |
| Supersedes     | (none)                             |
| Related specs  | 5076                               |

## 1. Problem Statement

Two company-page sources return 0 jobs even though their career pages are live and contain openings:

- `source-company-desktopmetal` (`desktopmetal.com`) — `/careers` lists role PDFs behind a Cloudflare managed challenge. The current `BrowserPool.getPage({ stealth: true })` launches an ephemeral headless Chromium context, which Cloudflare blocks.
- `source-company-truemetalsupply` (`truemetalsupply.com`) — a Wix page with popup/lightbox dialogs. The current `BrowserPool.getPage({ stealth: true })` also uses a fresh headless context and is blocked, so no dialog triggers are found.

Both sources need the persistent, headful Chromium context added in Spec 5076. True Metal Supply also needs a popup-reading fix: the generic `[role="dialog"]` selector matched a hidden container, and the first Wix dialog trigger is hidden; the scraper now skips zero-size triggers and reads each popup by its Wix `data-popupid`/`id`.

## 2. Goals

- Use the new `BrowserPool` `headful` opt-in in `DesktopmetalService` and `TrueMetalSupplyService`.
- Keep all existing parsing and mapping logic unchanged.
- Add or update unit tests that assert each service asks `BrowserPool.getPage` for `{ stealth: true, headful: true }`.
- Do not touch the fetch1 callers, slug metadata, or any other source plugin.

## 3. Non-Goals

- No new ATS or company plugin.
- No `companyUrl`, `file://`, or fetch1 cache integration.
- No changes to `BrowserPool` itself; the generic capability already landed in Spec 5076.
- No attempt to solve CAPTCHA or interactive challenges automatically.
- No real user Chrome profile.

## 4. Changes

1. `DesktopmetalService.fetchListingHtml` passes `headful: true` to `BrowserPool.getPage` and updates its JSDoc to say "headful" instead of "headless".
2. `TrueMetalSupplyService.fetchOpenings` passes `headful: true` to `BrowserPool.getPage` and updates its JSDoc accordingly.
3. `TrueMetalSupplyService.collectDialogs` now:
   - skips triggers with a zero-size bounding box (the first Wix trigger is a hidden non-job popup),
   - reads the popup via the trigger's `data-popupid` mapped to the popup `div[id="..."]` instead of the ambiguous `[role="dialog"]` selector,
   - waits for the popup to become visible before extracting text/html.
4. Update the `source-company-truemetalsupply` `fakePage` test helper to expose `boundingBox`, `getAttribute('data-popupid')`, and `waitFor` so the new `collectDialogs` loop is exercised in unit tests.
5. Add a focused unit test in each plugin's `__tests__/*.service.spec.ts` that mocks `BrowserPool.getPage` and asserts it is called with `expect.objectContaining({ stealth: true, headful: true }).`

## 5. Test Plan

- `npx jest --testPathPatterns=source-company-desktopmetal` passes, including the new `BrowserPool` option assertion.
- `npx jest --testPathPatterns=source-company-truemetalsupply` passes, including the new `BrowserPool` option assertion.
- `npx tsc --noEmit --project tsconfig.base.json` is clean.
- `npm run lint:docs` is clean.
