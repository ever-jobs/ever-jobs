# Tasks: 1680 — Diagnostics semantics, and the two backends that gate 300 wrappers

- [x] T1 — `@ever-jobs/models`: add `partial` and `not_registered` to `ScrapeReason` and to `ACTIONABLE_SCRAPE_REASONS`. Acceptance: union widened with no exhaustive consumer broken (verified: referenced outside `packages/models` in exactly two lines, both in `jobs.service.ts`; no `switch`, no `: never`, no `@ApiProperty` enum).
- [x] T2 — `classifyScrapeError`: classify remaining 4xx (404/410/400/422 and worded "not found") as `bad_input`, after the existing rules so 403 stays `blocked` and 429 stays `fetch_error`. Acceptance: 404 no longer falls through to `unknown`.
- [x] T3 — `classifyScrapeError`: match `401`/`407`/`unauthorized` as `blocked`, so an auth refusal is not swept into the new 4xx rule. Acceptance: both classify as `blocked`.
- [x] T4 — `apps/api`: infer `partial` when a source returns jobs AND a diagnostic. Acceptance: `ok` for jobs alone, `partial` for jobs + diagnostic, the plugin's reason for zero + diagnostic, `empty` for zero alone.
- [x] T5 — `apps/api`: derive the `scraperRequestsTotal` status label from `response.diagnostics?.reason` rather than from the promise settling. Without this the migration improves `per_source` and leaves every dashboard wrong. Acceptance: `blocked` on a failed scrape, `partial` on a partial one, `success` when no diagnostic is reported.
- [x] T6 — `source-ats-smartrecruiters`: report `classifyScrapeError(err)` alongside the partial results it already returned. Was the worst single defect in the tree — partials with no signal, so a page-2 failure looked exactly like a complete board. Acceptance: unblocks 213 delegating wrappers.
- [x] T7 — `source-ats-recruitee`: report `classifyScrapeError(err)` from the outer catch. Acceptance: unblocks 82 delegating wrappers.
- [x] T8 — Both backends: the `if (!companySlug)` guard reports `bad_input` instead of a bare empty result. Acceptance: a wiring/input error is no longer indistinguishable from an empty board.
- [x] T9 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry newest-at-top; `tsc --noEmit` clean (same 10 pre-existing module-resolution errors as `develop`) and `lint:docs` clean.

## Notes

**Deliberately not done here** — the rest of the sequence, each depending on the semantics above:

- **PR 2** — the six scaffolders (`scaffold-{company,ashby,lever,recruitee,smartrecruiters,workable}-company-source.ts`), so no generator keeps minting the bug. Only one has a spec today; five need writing.
- **PR 3** — the 699 delegating services and their specs (anchor must tolerate `\'` in seven names).
- **PR 4** — the 822 canonical-swallow services and 806 specs, plus `source-company-tiktok` by hand. Gate: `--expect=822`, `+3/-1` numstat per file.
- **PR 5** — the 268-file tail, clustered by exact catch-tail and dry-run per cluster. `source-ats-rippling` carries the one spec assertion in the repo that actually breaks.

**Partial-result recovery** is a separate concern: `recruitee`, `ashby` and `lever` declare their accumulator *inside* the `try`, so it is out of scope in the catch and they return `[]` on failure. Preserving partials there needs a hoist plus test review — `ashby`'s specs assert `jobs).toEqual([])` on error paths today.
