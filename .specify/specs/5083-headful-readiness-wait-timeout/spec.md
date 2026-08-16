# Spec: 5083 — Headful readiness waits hang the whole scrape

| Field          | Value                                 |
| -------------- | ------------------------------------- |
| Spec ID        | 5083                                  |
| Slug           | headful-readiness-wait-timeout        |
| Status         | done                                  |
| Owner          | agent                                 |
| Created        | 2026-06-28                            |
| Last updated   | 2026-06-28                            |
| Supersedes     | (none)                                |
| Related specs  | 5076, 5077, 5081, 5082                |

## 1. Problem Statement

The three headful (`BrowserPool.getPage({ headful: true })`) scrapers each gate readiness on a
`page.waitForSelector(selector, { timeout: navTimeoutMs })` whose `navTimeoutMs` is the plugin's
full navigation budget (**30 s**). When the gated selector is absent — or attached but never
"visible" — the wait consumes the **entire 30 s**, even though the page's content was already
present within ~1 s. The scrape then finishes just past 30 s and a downstream caller with a 30 s
HTTP read timeout reports a client-side `timeout` — while the operator can plainly see the
page loaded in the visible browser.

Reproduced locally (headful + the plugin stealth init script), timing from `goto` resolution:

- **`source-ats-gusto-hosted` — detail page.** Posting page loads in **0.77 s** (real title, 119 KB),
  but Gusto posting pages carry **zero** `<script type="application/ld+json">` blocks. The detail
  fetch waits for that selector for the full **30 s**, then falls back to HTML parsing it could have
  done immediately. With the detail fan-out this pushes a small board past 30 s. `<h1>` is present at
  **0.02 s**.
- **`source-company-truemetalsupply`.** `/careers` loads in **0.68 s**; the 8 Wix dialog triggers are
  attached at **0.05 s** but never become Playwright-`visible`, so the default (`state: 'visible'`)
  `waitForSelector` burns the full **30 s** — pointlessly, because `collectDialogs` then enumerates
  the triggers via `locator.count()` regardless.
- **`source-company-desktopmetal`.** `/careers` and its PDF anchors resolve in **1.7 s** — this one
  happens to work today, but it shares the same `timeout: navTimeoutMs` readiness pattern and would
  hang identically if the listing markup ever changed.

Root cause is a category, not three coincidences: **a best-effort readiness wait must not be allowed
to consume the whole navigation/HTTP budget, and it must gate on an element that is actually present
in the state being awaited.**

## 2. Goals

- No headful readiness `waitForSelector` can consume more than a small, bounded slice of the request
  budget; a missing/late selector costs seconds, not the full 30 s.
- Gate each readiness wait on an element that is reliably present in the awaited state:
  - gusto-hosted detail → `h1` (present immediately) instead of the absent JSON-LD;
  - truemetalsupply → the dialog trigger in `state: 'attached'` (it is attached, never "visible").
- Preserve all parsing/output behavior: the JSON-LD path in gusto-hosted still runs when present, and
  every plugin still falls back to its existing HTML parse.
- Keep the change breaker-neutral and diagnostics-compatible with Spec 5082 (still return
  `JobResponseDto([], { reason: 'empty' | ... })`, never throw for a slow gate).

## 3. Non-Goals

- No change to any external caller's HTTP timeout; this fixes the server so it answers
  well under any reasonable client timeout.
- No change to what is scraped, parsed, or mapped, nor to any response shape.
- No change to the `goto` navigation timeout (network-level) or to `BrowserPool`.
- No new anti-bot/stealth work; the challenge already clears in ~3 s with the existing stealth script.

## 4. Design

Split the single per-navigation timeout into two intents:

- **navigation timeout** (`*_DEFAULT_TIMEOUT_SECONDS`, unchanged, 30 s) — used only by `page.goto`.
- **readiness timeout** (new `*_READY_TIMEOUT_SECONDS`) — used by every best-effort
  `waitForSelector` / `waitFor`. Chosen comfortably above the observed content-ready time yet well
  under the caller budget:
  - gusto-hosted: **15 s** (board must clear the Cloudflare challenge, ~3 s observed);
  - desktopmetal: **15 s**;
  - truemetalsupply: **12 s** trigger readiness; per-dialog visible wait bounded to
    `TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS` (**6 s**) so one non-opening dialog cannot serialize
    into 30 s+.

Selector/state corrections:

- gusto-hosted `fetchPostingHtml` readiness selector: `script[type="application/ld+json"]` → `h1`.
  `parseDetail` still tries JSON-LD first, then the existing HTML fallback — output unchanged.
- truemetalsupply trigger wait: add `state: 'attached'`.

## 5. Changes

1. `source-ats-gusto-hosted/src/gusto-hosted.constants.ts` — add `GUSTO_HOSTED_READY_TIMEOUT_SECONDS = 15`.
2. `gusto-hosted.service.ts` — `fetchRenderedHtml` uses the ready timeout for `waitForSelector`
   (goto keeps the nav timeout); posting readiness selector → `h1`.
3. `source-company-desktopmetal/src/desktopmetal.constants.ts` — add `DESKTOPMETAL_READY_TIMEOUT_SECONDS = 15`.
4. `desktopmetal.service.ts` — listing readiness `waitForSelector` uses the ready timeout.
5. `source-company-truemetalsupply/src/truemetalsupply.constants.ts` — add
   `TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS = 12` and `TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS = 6000`.
6. `truemetalsupply.service.ts` — trigger `waitForSelector` → `{ state: 'attached', timeout: readyMs }`;
   per-dialog `waitFor({ state: 'visible' })` bounded by the dialog-visible timeout.

## 6. Test Plan

- gusto-hosted: a fake page whose `waitForSelector` rejects for the JSON-LD selector but resolves for
  `h1` still yields a parsed detail (proves readiness no longer depends on JSON-LD); existing fixture
  tests unchanged.
- truemetalsupply: assert the trigger wait is invoked with `state: 'attached'` and the bounded
  timeout; existing dialog-fixture tests unchanged.
- desktopmetal: existing fixture tests unchanged; assert the readiness wait uses the ready timeout.
- `npx tsc --noEmit --project tsconfig.base.json` clean; `npm run lint:docs` clean; touched plugin
  jest suites green.

## 7. Downstream (external caller, out of this repo)

A downstream caller's `timeout` message is its own client-side HTTP read timeout, not an ever-jobs
scraper reason. With this fix the server answers in seconds, so that timeout stops firing. No code
in this repo depends on any external caller.

## 8. Follow-up (T6) — truemetalsupply first-click retry

While validating the timeout fix live, truemetalsupply returned **6** roles though the board renders
**7**. Root cause (separate from the readiness wait): the **first** Wix popup click of a page can
land before Thunderbolt has wired the popup handler, so it opens nothing and the trigger is skipped —
dropping the first role (Estimator). Reproduced live: Estimator's popup opens fine in isolation but
not as the first click in the sequential enumeration.

Fix: `TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS = 2`; the click→open step becomes `openTriggerDialog`,
which re-clicks (Escape + settle) until the popup is `visible`, each attempt still bounded by
`TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS`. Test: a `fakePage` `opensAfter` knob + a case asserting a
first-click-opens-nothing trigger still yields its role. Live-verified: `jobs=7 reason=ok elapsed=18.0s`.
