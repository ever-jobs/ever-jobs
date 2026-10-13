# Plan: 5167 — source-tesla browser fallback when the plain board GET fails

| Field | Value |
| --- | --- |
| Spec ID | 5167 |
| Slug | tesla-browser-fallback |
| Status | draft |
| Owner | agent |
| Created | 2026-10-01 |

## Approach

`source-tesla` keeps the HTTP-first fast path untouched. `scrape()` gains one
decision point: `board === null` → `scrapeViaBrowser()`. The browser path
mirrors `source-tesla-playwright`'s proven flow (lazy import, anti-automation
launch args, careers-page settle, in-page `fetch()`) but emits `Site.TESLA`
and lives inside the default plugin — no cross-plugin import.

Fallback internals: try headless first; if the in-page board fetch still
cannot read `listings[]` after 3 polls (4 s apart), close and relaunch
**headed** once (observed live: headless gets edge "Access Denied" with zero
cookies while a headed window passes and returns the board JSON — reason not
asserted). A headed launch without a display throws instantly → same empty
DTO as today.

Navigation uses `waitUntil: 'domcontentloaded'` — `networkidle` never
settles on the careers SPA (it holds telemetry/asset connections open).

## Files

- `packages/plugins/source-tesla/src/tesla.constants.ts`
    - Header note → HTTP-first + lazy fallback.
    - `TESLA_DEFAULT_DESCRIPTION_DEPTH`: `'detail-25'` → `'board'`
      (detail-all ≈ ~8k+ sequential requests = tens of minutes + likely
      per-IP rate-limit trips; detail-25 = arbitrary partial set).
    - `TESLA_CAREERS_PAGE`, `TESLA_LAUNCH_ARGS`, `TESLA_SETTLE_MS`,
      `TESLA_GOTO_TIMEOUT_MS`, `TESLA_BOARD_RETRY_MS`, sentinels
      `TESLA_ERR_BROWSER_UNAVAILABLE` / `_NAV` / `_FETCH_FAILED`.
- `packages/plugins/source-tesla/src/tesla.service.ts`
    - `scrape()`: `board === null` → `scrapeViaBrowser()`.
    - New privates: `scrapeViaBrowser` (headless→headed loop),
      `browserAttempt`, `loadPlaywright` (Function-wrapped
      `import('playwright')`), `openCareersPage`, `fetchInPage`,
      `fetchDetailInPage`, `sleep`. `toJobPost`, `composeDescription`,
      `resolveDepth` reused as-is.
- `packages/plugins/source-tesla-playwright/src/tesla-playwright.constants.ts`
    - `TESLA_PLAYWRIGHT_DEFAULT_DESCRIPTION_DEPTH` → `'board'` (consistency;
      the companion is unwired — kept as reference code only, noted in its
      service docstring).
- Tests: fallback wiring via private-method spies (no real browser),
  headless→headed escalation, default-depth assertions flipped.
- `docs/index.md`, `docs/log.md` — spec row + changelog entry.

## Risks

- `import('playwright')` must stay lazy: the Function-wrapped form keeps
  TypeScript/Node from resolving it at module load, so installs without
  playwright still boot.
- `page.evaluate` closures must be self-contained (no captured imports) —
  in-page `fetch` uses string literals only.
- Escalation cost: worst case one extra navigation + settle per scrape
  that would otherwise return `[]`.
