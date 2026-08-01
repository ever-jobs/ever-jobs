# Spec: 5024 — Bounded store retention on the interactive search path

| Field | Value |
| --- | --- |
| Spec ID | 5024 |
| Slug | bounded-store-retention |
| Status | implemented |
| Owner | agent |
| Created | 2026-07-30 |
| Last updated | 2026-07-30 |
| Related specs | 004, 005, 5025, 5026 |

## Problem

The production API (`.deploy/k8s/k8s-manifest.prod.yaml`, `limits.memory: 4Gi`,
`replicas: 1`) is being OOMKilled on a repeating cycle: fresh pod → RSS climbs →
kernel SIGKILL (exit 137) → restart → climbs again.

The dominant monotonic retainer is the **in-memory job store, silently active in
production**:

1. `EVER_JOBS_STORE` is not set in the Dockerfile, either compose file, or the
   k8s manifest.
2. `store-bootstrap.factory.ts` therefore resolves `DEFAULT_STORE_ID = 'memory'`
   and `app.module.ts` binds `InMemoryJobStore` under `JOB_STORE_TOKEN`,
   `JOB_OBSERVATION_STORE_TOKEN` **and** `HEALTH_SNAPSHOT_STORE_TOKEN`.
3. `JobsController.searchJobs` calls `aggregator.aggregateRaw(rawJobs, { dedup })`
   without a `persist` key, and `JobsAggregator.maybePersist` reads
   `options.persist ?? true` — so **persistence is on for every request**,
   including cache hits (the call sits outside the cache `if/else`).
4. `InMemoryJobStore.canonicals` and `.observations` are plain `Map`s with **no
   cap, no TTL, no LRU and no sweep**. The only `delete`/`clear` call sites in
   the repo are tests.

A `CanonicalJob` holds its winning source job's `description` **by reference**,
so each retained row pins a full markdown job description. Nothing in
`apps/api` ever reads the corpus back — `listByQuery`, `getById`,
`findByCanonicalId` have zero non-test callers. It is a pure write-only sink
that grows for the lifetime of the process.

The same class already caps its `snapshots` ring at `DEFAULT_SNAPSHOT_CAP`
(Spec 005 / T09) with a `splice` trim. The job maps were simply never given the
same treatment.

## Scope

- Cap `canonicals` (cascading into `observations`) in `InMemoryJobStore`,
  mirroring the existing snapshot-ring pattern. Env-tunable via
  `EVER_JOBS_STORE_MAX_ROWS`, per-instance override via `setRowCap()`.
- Add `store.persistSearch` config (`EVER_JOBS_PERSIST_SEARCH`) and thread it
  through `JobsController.searchJobs` and `JobsResolver.searchJobs`.
- Warn at bootstrap when `NODE_ENV=production` resolves the `memory` backend.

## Non-goals

- **Changing the default behaviour.** `store.persistSearch` defaults to `true`
  and `EVER_JOBS_STORE` keeps defaulting to `memory`. Per AGENTS.md rule 9 this
  spec is additive: it makes the growth *bounded* and gives operators a switch,
  it does not remove persistence. Flipping the production default is a
  deployment decision recorded in the PR, not a code default.
- Wiring a durable backend. `EVER_JOBS_STORE=postgres` fails fast without
  `STORE_POSTGRES_PRISMA_CONFIG` (which nothing in `apps/api` binds) and
  `sqlite` falls back to `:memory:` — both are follow-ups, not this spec.
- The other two OOM contributors (Specs 5025, 5026).

## Contracts

| Surface | Contract |
| --- | --- |
| `EVER_JOBS_STORE_MAX_ROWS` | Positive integer. Unset / empty / non-numeric / `<= 0` → `DEFAULT_ROW_CAP` (50 000). |
| `EVER_JOBS_PERSIST_SEARCH` | Bool (`true/1/yes/on`). Default `true`. `false` → `aggregateRaw` receives `persist: false`; `AggregateResult.persisted` is `undefined`. |
| `InMemoryJobStore.setRowCap(n)` | Throws `RangeError` on non-positive / non-finite. Trims immediately. |
| `InMemoryJobStore.rowCapacity` | Resolved cap, diagnostics only. |
| Eviction order | **First-insert-first-out, not LRU.** `Map.set` on an existing key does not move it in iteration order. Documented as a safety valve, not a cache policy. |
| `observations` bound | Enforced **independently** of `canonicals`, not only by cascade — see below. |

### Why `observations` needs its own bound

`JobsAggregator.maybePersist` runs `upsertMany(batch)` and then calls
`putAll(id, …)` for **every** id in that batch. When a batch exceeds the cap,
`upsertMany` evicts some of the ids it just inserted — and the following
`putAll` loop writes their observations straight back. Those orphans have no
canonical left to cascade from, so a cascade-only trim would let `observations`
grow without limit and merely relocate the leak this cap exists to close.

Measured: 5 rounds of a 100-job batch against a cap of 10 leaves **460**
observation entries with a cascade-only trim, and ≤ 10 with the independent
bound. `putAll` therefore calls `trimRows()` as well.

## Test plan

Unit (`packages/plugins/store-memory/__tests__/store-memory.spec.ts`):

- `resolveRowCap` default / override / junk-value matrix.
- `upsert` trims oldest-first past the cap.
- `upsertMany` trims a whole over-cap batch — the regression guard against
  using `if` instead of `while` (one search can upsert tens of thousands).
- Trim cascades into `observations` (dropping a canonical alone frees nothing,
  because `putAll` stores a shallow `.slice()`).
- **Orphan write-back guard** — replays the exact `maybePersist` sequence
  (`upsertMany(100)` then `putAll` for all 100) five times against a cap of 10
  and asserts both maps stay bounded. Verified to fail (460 observations) with
  the independent `observations` bound removed.
- `setRowCap` trims immediately; rejects `0` / negative / `NaN`.
- Re-upserting an existing id does not grow past the cap.

Existing 24-case store conformance suite must stay green (the cap is far above
any fixture size).

API: existing `apps/api` suites must stay green with the new `ConfigService`
dependency on `JobsController` / `JobsResolver`.
