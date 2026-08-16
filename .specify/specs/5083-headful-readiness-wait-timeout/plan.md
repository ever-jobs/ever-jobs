# Plan: 5083 — Headful readiness waits hang the whole scrape

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-06-28                         |
| Last updated | 2026-06-28                         |

## Phases

1. **Constants.** Add a `*_READY_TIMEOUT_SECONDS` to each of the three headful plugins' constants
   files (and `TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS`). Leaf change, no behavior yet.
2. **gusto-hosted.** `fetchRenderedHtml` uses the ready timeout for `waitForSelector`; posting
   readiness selector `script[type="application/ld+json"]` → `h1`. `parseDetail` unchanged (still
   JSON-LD-first with HTML fallback).
3. **truemetalsupply.** Trigger `waitForSelector` → `{ state: 'attached', timeout: readyMs }`;
   per-dialog `waitFor({ state: 'visible' })` bounded by the dialog-visible timeout.
4. **desktopmetal.** Listing readiness `waitForSelector` uses the ready timeout.
5. **Tests + docs.** Extend the three plugin suites for the new wait arguments; update
   `docs/index.md`, `docs/log.md`.

## Packages touched

- `packages/plugins/source-ats-gusto-hosted`
- `packages/plugins/source-company-truemetalsupply`
- `packages/plugins/source-company-desktopmetal`

## Risks

- Too-short a ready timeout could give up before the Cloudflare challenge clears (~3 s observed) →
  chosen 12-15 s, ample margin, still << the 30 s caller budget.
- Changing the gusto readiness selector could regress detail parsing → mitigated: JSON-LD parse still
  runs first when present; `h1` is only the readiness gate.
- Bounding the per-dialog visible wait could drop a genuinely slow dialog → 6 s is far above the
  observed ~0.6 s settle; a dialog that has not opened in 6 s was not going to.
