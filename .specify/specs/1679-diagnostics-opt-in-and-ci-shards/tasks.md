# Tasks: 1679 — Opt-in per-source diagnostics, and a source-test suite that can finish

- [x] T1 — `@ever-jobs/models`: add `ACTIONABLE_SCRAPE_REASONS`, `DiagnosticsMode`, `DEFAULT_DIAGNOSTICS_LIMIT`, `ScrapeDiagnosticsSummaryDto` and the pure `summarizeSourceDiagnostics(rows, mode, limit)`. Acceptance: filters `ok`/`empty`, caps, and returns a summary computed over the full fan-out even when no rows are returned.
- [x] T2 — `summarizeSourceDiagnostics`: a non-positive or non-finite limit means *no cap*, not *no rows*. Acceptance: `0`, `-1` and `NaN` all return the full selection.
- [x] T3 — `apps/api`: `?diagnostics=` (absent/`false` → off, `true` → actionable, `all` → everything) and `?diagnostics_limit=`, applied once and used on both the paginated and standard response branches. Acceptance: default returns `per_source: []` with a complete `per_source_summary`.
- [x] T4 — `apps/api`: append the two new `@Query` params **after** `@Res()`. Nest binds by decorator, but the parameter list is positional for direct callers and inserting ahead of `res` shifted it — which broke the existing CSV-export test. Acceptance: pre-existing controller tests pass unchanged.
- [x] T5 — Swagger: document both params and why diagnostics are off by default (~1 651 rows / ~78 KiB per response). Acceptance: `@ApiQuery` entries present.
- [x] T6 — CI: shard `Test (Source Scrapers)` six ways via a matrix and `jest --shard=N/6`, `fail-fast: false`, `continue-on-error` retained, `timeout-minutes: 180`. Acceptance: shard test-counts sum exactly to the unsharded total (303+303+303+302+302+302 = 1 815).
- [x] T7 — CI: `timeout-minutes` on every other job (Docs Lint 30, Build 45, Health & Smoke 30, E2E 60, Feature Plugins 45, Docker 60), roughly 3× observed durations. Acceptance: no job can run to GitHub's 360-minute ceiling.
- [x] T9 — `dedup-hybrid`: split the cold NFR-1 assertion onto its own `DEDUP_COLD_NFR1_MS` knob (CI: 4 000 ms). Spec 1678 correctly stopped it hardcoding 250 ms, but wired it to `DEDUP_PERF_NFR1_MS` — the budget for `dedup-perf.spec.ts`, which builds its batch once and takes the max over 5 **warmed** runs (20–40 ms observed). The functional-suite copy times a single **unwarmed** `dedup()`, so it measures JIT compilation of the pipeline: 1 251 ms and 1 451 ms observed on the same runner, i.e. a ~40x gap that is warm-up, not throughput. Sharing one knob meant the only way to stop the flake was to loosen the authoritative gate. Acceptance: `DEDUP_COLD_NFR1_MS=1` fails and names the budget in the title; `DEDUP_PERF_NFR1_MS` still governs the warmed gate at 1 000 ms; suite green at the defaults and under the CI env.
- [x] T8 — Docs: `docs/index.md` row + footer, `docs/log.md` entry newest-at-top; `tsc --noEmit` and `lint:docs` clean.

## Notes

**Not done — runner-pool relabelling.** Considered and rejected on evidence: the 429
action-download failures hit `ever-jobs-linux-x64-4` and `ever-jobs-linux-x64-8` with the *same*
action SHA inside the same three-minute window (jobs 95394299637 and 95394300781), so moving the
publish jobs between pools does not address the failure that actually occurred, and it would put the
entire production shipping path in the same pool as all of CI. The real fixes are ARC-side — bake
the actions into the runner image or front the pool with a cache, and raise `minRunners` on `_8` —
and are infra-owned rather than repo-owned.

**Not done — bounding the underlying cause.** ~1 540 `source-company-*` plugins swallow errors and
return a bare `{ jobs: [] }`, so genuine failures report as `empty`. That is why the actionable
filter is so effective, and also why the diagnostics are less informative than they look. Fixing it
means touching every scaffolded plugin and the scaffolder itself.
