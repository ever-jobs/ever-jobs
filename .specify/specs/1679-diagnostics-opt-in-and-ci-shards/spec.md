# Spec: 1679 — Opt-in per-source diagnostics, and a source-test suite that can finish

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1679                                       |
| Slug           | diagnostics-opt-in-and-ci-shards           |
| Status         | done                                       |
| Owner          | agent                                      |
| Created        | 2026-08-17                                 |
| Last updated   | 2026-08-17                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5026, 5082, 1678                           |

## 1. Problem Statement

### 1.1 `per_source` shipped ~1 650 rows on every search response

Spec 5082 added a per-source outcome breakdown to `/api/jobs/search`. It is emitted unconditionally,
one row per fanned-out source, on **both** response branches (`jobs.controller.ts:207` and `:224`) —
so the existing pagination window does not touch it.

The default site selection is every registered source minus the ATS ones
(`jobs.service.ts:182-184`): **1 831 − 180 = 1 651 rows**. Measured against the real `Site` tokens:

| Case | Size |
|---|---|
| Common (no `detail`) | **~78 KiB** |
| Deadline-skipped rows carry a `detail` | ~174 KiB |
| Worst case (300-char `detail`, the `MAX_DETAIL` cap, on every row) | **~604 KiB** |

`apps/api/src/main.ts` registers no compression middleware, so that ships uncompressed from the app.

The signal-to-noise is the real problem. Only 45 plugins in the tree ever construct diagnostics, and
24 of those are `source-ats-*` — excluded from the default fan-out. The ~1 540 scaffolded
`source-company-*` plugins swallow errors and return a bare `{ jobs: [] }`, so they surface as
`empty` whatever actually happened. In practice **≥98% of the payload is `ok`/`empty`**, and the
handful of rows an operator would act on are buried in it — defeating the purpose the field exists
for.

### 1.2 `Test (Source Scrapers)` could never finish

`jest --listTests` reports **1 815 suites** under `packages/plugins/source-`. At ~17 s of wall-clock
each that is ~8.5 h, past GitHub's 360-minute job ceiling, and the job set no `timeout-minutes`.

It was **not** hanging. The last unsharded run logged `PASS` lines continuously from 11:32:21 to
17:25:39 and was killed mid-flight having completed **1 221 of 1 815** suites. So the remaining ~590
were never exercised, the job could never report a result, and it occupied a runner slot for six
hours on a pool whose contention had already delayed a production deploy.

## 2. Goals

- Stop paying ~78 KiB of mostly-noise on every search response, without losing the diagnostic.
- Let a caller ask for the detail when it wants it, and always be able to see the totals.
- Make the source-scraper suite complete, and make it impossible for any CI job to squat a runner
  for six hours again.

## 3. Non-Goals

- Fixing the ~1 540 plugins that swallow their errors into `empty`. That is the deeper cause of the
  poor signal, and it is a much larger change.
- Changing the default site selection (Q-OOM-1 — needs Hust sign-off).
- Moving jobs between runner pools. The 429 action-download failures hit **both** pools with the
  same action SHA inside the same three-minute window, so relabelling provably does not address
  them; the fix is ARC-side (bake or cache the actions) and infra-owned.

## 4. Design

### 4.1 `summarizeSourceDiagnostics` (in `@ever-jobs/models`)

A pure function — no I/O, trivially testable — returning `{ rows, summary }`:

- **Filter.** `ACTIONABLE_SCRAPE_REASONS` = `blocked`, `browser_unavailable`, `fetch_error`,
  `timeout`, `bad_input`, `circuit_open`, `unknown`. `ok` and `empty` are dropped.
- **Cap.** `DEFAULT_DIAGNOSTICS_LIMIT = 200`. A non-positive or non-finite limit means *no cap*
  rather than *return nothing* — silently emptying a diagnostics payload is the worse failure.
- **Summary.** `{ total, actionable, returned, truncated, by_reason }`, computed over the **full**
  fan-out. It is populated even when no rows are returned, so a caller can get totals without
  pulling 1 651 rows.

### 4.2 Opt-in at the controller

`?diagnostics=` — absent/`false` → `off` (no rows); `true` → actionable rows only; `all` → every
row. Both non-off modes are capped, overridable with `?diagnostics_limit=`.

The two new `@Query` parameters are appended **after** `@Res()`. Nest binds by decorator so runtime
order is irrelevant, but the parameter list is positional for direct callers — the unit tests
construct the controller and call it directly — and inserting ahead of `res` silently shifts it.

`per_source` keeps its name and shape; `per_source_summary` is additive.

### 4.3 Shard the source-scraper job

Six shards via a matrix and `jest --shard=N/6`, `timeout-minutes: 180`, `fail-fast: false`,
`continue-on-error` retained. ~300 suites and ~1.4 h each, same total runner time, and every suite
runs. Verified locally that the partition is exact: 303+303+303+302+302+302 = 1 815.

Every other job gets a `timeout-minutes` sized at roughly 3× its observed duration (Docs Lint 30,
Build 45, Health & Smoke 30, E2E 60, Feature Plugins 45, Docker 60), so no job can ever again hold a
slot to the platform ceiling.

## 5. Acceptance

- Default response returns `per_source: []` with a complete `per_source_summary`.
- `?diagnostics=true` returns only actionable reasons; `all` returns everything; both respect the cap
  and report `truncated`.
- The six shards partition the suite exactly, with nothing dropped or duplicated.

## 6. Risks

- **`per_source` becomes empty by default.** Verified non-breaking: `ever-hust` — the only consumer —
  never references `per_source`/`perSource`, its `JobSearchResponse` type does not declare it, and it
  casts the response rather than parsing it, so unknown/absent fields are inert. The window to make
  this change cheaply is now.
- Six concurrent shards take more pool slots at once than one job did, though for the same total
  runner time and a much shorter wall clock.
