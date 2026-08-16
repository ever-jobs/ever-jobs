# Tasks: 5083 — Headful readiness waits hang the whole scrape

- [x] T1 — gusto-hosted: add `GUSTO_HOSTED_READY_TIMEOUT_SECONDS = 15`; `fetchRenderedHtml` uses it for `waitForSelector` (goto keeps nav timeout); posting readiness selector → `h1`. Acceptance: detail fetch returns as soon as `h1` is present; JSON-LD parse still used when present.
- [x] T2 — truemetalsupply: add `TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS = 12` + `TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS = 6000`; trigger `waitForSelector` → `{ state: 'attached', timeout: readyMs }`; per-dialog visible wait bounded. Acceptance: trigger enumeration no longer blocks on `visible`.
- [x] T3 — desktopmetal: add `DESKTOPMETAL_READY_TIMEOUT_SECONDS = 15`; listing readiness `waitForSelector` uses it. Acceptance: listing wait bounded below caller budget.
- [x] T4 — Extend the three plugin jest suites for the new wait arguments/selectors; keep existing fixtures green.
- [x] T5 — Docs: update `docs/index.md`, `docs/log.md`. `tsc --noEmit` + `lint:docs` clean.
- [x] T6 (follow-up) — truemetalsupply: the first Wix popup click of a page can land before the popup handler is wired and open nothing, dropping the first role (board shows 7, scrape returned 6). Add `TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS = 2`; extract `openTriggerDialog` which re-clicks (Escape + settle) until the popup is visible, each attempt bounded by the dialog-visible timeout. Test: `fakePage` `opensAfter` knob + a no-first-role-drop case. Acceptance: live production service returns all 7 roles (verified: `jobs=7 reason=ok elapsed=18.0s`).
