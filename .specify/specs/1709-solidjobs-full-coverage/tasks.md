# Tasks: 1709 — Solid.Jobs full coverage: every division, paging, client-side filters, full mapping

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Fetch

- [x] T01 — Constants: `SOLIDJOBS_DIVISIONS_ALL`, page-size/page-count caps, concurrency 2, 90 s budget, `PL`, hint stems, contract forms, honest User-Agent, env-var names; `SOLIDJOBS_HEADERS` without a User-Agent.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.constants.ts`
  - **Acceptance:** `SOLIDJOBS_DIVISIONS` override kept; headers carry `Accept` only.
- [x] T02 — Types: optional paging envelope, `secondarySalary`, `UoD`, optional absent-able fields.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.types.ts`
  - **Acceptance:** the Spec 718 fixture (no envelope) still parses.
- [x] T03 — Division scheduler (≤ 2 in flight; unfiltered waits for `totalCount`), sequential page loop with every stop condition, deterministic merge with de-duplication, `offset` slice.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.service.ts`
  - **Acceptance:** default fan-out = 1 request; `totalPages` honoured; 20-page cap; ignored `pageIndex` stops; division order independent of completion order.
- [x] T04 — Diagnostics: page/division failures, invalid payloads and the time budget.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.service.ts`
  - **Acceptance:** all-fail → `fetch_error`; page 1 fails → page 0 kept + diagnostic; budget → `partial` / `timeout`; enough jobs → none.
- [x] T05 — HTTP options: honest User-Agent unless `input.userAgent`; retry/rate/timeout pass-through.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.service.ts`
  - **Acceptance:** `createHttpClient` receives `userAgent`; `setHeaders` receives no User-Agent.

## Phase 2 — Filter and map

- [x] T06 — Pure filter helpers: fold (incl. `ł`), token search, phrase matcher, location needle (country words, remote words, exonyms, whole-word match), job-type rules, `hoursOld` window, filter builder, hint ordering, humaniser.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.filters.ts`
  - **Acceptance:** `solidjobs.filters.spec.ts` green.
- [x] T07 — Mapping: `datePosted` + Spec 1696 fields, `companyLogo`, `skills`, `jobLevel`, `jobFunction`, `workFromHomeType`, `employmentType`, secondary-salary compensation, `countryCode`, board-level country.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.service.ts`
  - **Acceptance:** mapping block of `solidjobs.coverage.spec.ts` green.
- [x] T08 — Env switches back to Spec 718: `SOLIDJOBS_PAGINATE`, `SOLIDJOBS_SEARCH_MODE`, `SOLIDJOBS_INPUT_FILTERS`; plus `SOLIDJOBS_TIME_BUDGET_MS`.
  - **Files:** `packages/plugins/source-solidjobs/src/solidjobs.{constants,service}.ts`
  - **Acceptance:** one test per switch.

## Phase 3 — Tests and docs

- [x] T09 — Synthetic fixtures (`solidjobs-it-page0.json`, `solidjobs-it-page1.json`, `solidjobs-sales-page0.json`); Spec 718 fixture kept as the no-envelope shape.
  - **Files:** `packages/plugins/source-solidjobs/__tests__/fixtures/`
- [x] T10 — Update the Spec 718 suite; add `solidjobs.coverage.spec.ts` and `solidjobs.filters.spec.ts`.
  - **Acceptance:** 137/137 across the three suites; mutation controls (concurrency 8, speculative unfiltered start, no `ł` fold, no `hoursOld` stop, no diagnostics) each fail the suite.
- [x] T11 — Refresh the live e2e: ≤ 3 results, 60 s timeouts, field shape, token search, a non-IT division.
  - **Files:** `packages/plugins/source-solidjobs/__tests__/solidjobs.e2e-spec.ts`
- [x] T12 — This spec, plan and tasks.
- [x] T13 — `docs/index.md` (link from the Spec 718 row) and `docs/log.md` entry — left to the integrator.
- [ ] T14 — Declare a crawl manifest on the decorator once `IPluginMetadata` has a `crawl` field.

## Notes

- Tests were written alongside each task; the mutation controls prove the new suites can fail.
