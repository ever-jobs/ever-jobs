# Plan: 5024 — Bounded store retention

| Field | Value |
| --- | --- |
| Spec ID | 5024 |
| Status | implemented |
| Created | 2026-07-30 |

## Approach

Three independent, individually revertable changes. Each is additive; none
changes a default.

### 1. Cap the maps (`packages/plugins/store-memory/src/store-memory.service.ts`)

Mirror the existing `DEFAULT_SNAPSHOT_CAP` / `setSnapshotCap` pattern rather
than inventing a new one:

- `DEFAULT_ROW_CAP = 50_000`, `STORE_MAX_ROWS_ENV_VAR`, `resolveRowCap(env)`.
- `private rowCap = resolveRowCap()`; `setRowCap()` test seam; `rowCapacity`
  getter.
- `private trimRows()` — a `while` loop over `canonicals.keys().next().value`,
  deleting from **both** maps.

Why a plugin-local `process.env` read instead of an injected `ConfigService`:
`StoreModule.forActive` instantiates the backend class directly with no
constructor arguments, which is the same constraint that drove `setSnapshotCap`
to a constant-plus-setter design. Introducing DI here would mean changing
`StoreModule`'s instantiation contract — out of scope for an incident fix.

`trimRows()` is called **once per `upsertMany`**, not per row: a single search
can upsert tens of thousands of canonicals and trimming inside the loop would
be O(n²) against the Map iterator.

### 2. Opt-out for interactive persistence (`apps/api`)

- `configuration.ts`: new `store: { persistSearch, maxRows }` block.
- `JobsController` and `JobsResolver` gain a `ConfigService` dependency and
  pass `{ dedup, persist }` to `aggregateRaw`.

`JobsAggregator` already treats "no persist" as a first-class outcome
(`maybePersist` returns `{}` and `persisted`/`persistCounts` are optional in
`AggregateResult`), so no aggregator change is needed.

### 3. Bootstrap warning (`store-bootstrap.factory.ts`)

Warn — not throw — when `NODE_ENV=production` resolves `memory`. `memory` is
legitimate for a stateless deployment that also sets
`EVER_JOBS_PERSIST_SEARCH=false`; the failure mode we are fixing is reaching it
by *omission* and only finding out via a post-mortem.

## Risks

| Risk | Mitigation |
| --- | --- |
| New `ConfigService` dep breaks test bootstraps that build `JobsController` by hand | Run the full `apps/api` suite; `ConfigModule` is global via `AppConfigModule`. |
| Cap silently discards rows a future reader depends on | No non-test readers exist today; the bootstrap warning and the spec record the trade-off. Cap is env-tunable. |
| FIFO eviction misread as LRU | Documented explicitly in the method doc, the spec contract table, and a test name. |

## Rollback

Each of the three changes is a separate concern in one commit; reverting the
commit restores byte-identical prior behaviour (defaults are unchanged).
