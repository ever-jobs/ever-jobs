# Spec: 1722 — Store backend selection that actually works from the environment

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1722                                     |
| Slug           | store-backend-selection                  |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-24                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 004, 5024                                |

## 1. Problem Statement

Spec 004 built three `IJobStore` backends (`store-memory`, `store-sqlite-drizzle`,
`store-postgres-prisma`) and Spec 004 / T12 let `EVER_JOBS_STORE` choose one. Measured against
"a forker sets two env vars and gets durable storage", the result does not work:

| Setting | What actually happens today |
| ------- | --------------------------- |
| nothing set | `memory` backend; **`EVER_JOBS_PERSIST_SEARCH` defaults to `true`**, so every search writes every canonical job into the process heap (bounded only by `EVER_JOBS_STORE_MAX_ROWS=50000`), and nothing ever reads it back. |
| `EVER_JOBS_STORE=sqlite` | the SQLite backend boots with its default `:memory:` database because nothing binds `STORE_SQLITE_DRIZZLE_CONFIG` — a "durable" choice that silently is not. |
| `EVER_JOBS_STORE=postgres` | **the API does not boot**: `PostgresPrismaJobStore` throws because nothing binds `STORE_POSTGRES_PRISMA_CONFIG`. The only fix is editing `app.module.ts`. `DATABASE_URL` is read by nobody. |
| `EVER_JOBS_STORE=store-postgres-prisma` | `ERR_STORE_NOT_FOUND` — package names are not accepted. |

Our own deployment sets `EVER_JOBS_PERSIST_SEARCH=false` and no `EVER_JOBS_STORE`, which is the
only configuration that behaves sensibly — and it must keep behaving exactly as it does.

## 2. Goals

- Persistence **off by default**, **on by default when a durable backend is chosen**, explicit
  value always wins.
- Every backend functional from env alone, failing fast at boot with a message that names the
  missing variable.
- Schema creation for Postgres documented and scripted.

## 3. Non-Goals

- A read API over the store (`GET /api/jobs?cursor=`) — Spec 004 leaves it for later.
- Auto-migrating the database at boot (see Q-102).
- New backends.

## 4. Caller Stories

> As a **forker**, I want `EVER_JOBS_STORE=postgres` and `EVER_JOBS_STORE_DATABASE_URL=…` to
> give me a Postgres-backed corpus without editing code.

> As **our operator**, I want the current deployment (no store vars, persist off) to be
> unaffected.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `EVER_JOBS_STORE` accepts `memory`, `sqlite`, `postgres` and the plugin package names `store-memory`, `store-sqlite-drizzle`, `store-postgres-prisma` (optionally `@ever-jobs/`-prefixed), plus `in-memory`, `sqlite-drizzle`, `postgres-prisma`, `postgresql`. Trimmed; lower-case only — Spec 004 / T12 deliberately rejects `MEMORY` / `Postgres` so config drift is loud, and that test is kept. | must |
| FR-2  | `EVER_JOBS_STORE_PLUGIN` is an alias read when `EVER_JOBS_STORE` is unset/blank. If both are set and resolve to different backends → boot fails with `ERR_STORE_CONFLICT`. | must |
| FR-3  | Unknown value → boot fails with the existing `ERR_STORE_NOT_FOUND`, listing accepted values. | must |
| FR-4  | `EVER_JOBS_PERSIST_SEARCH`: explicit value wins (`true/1/yes/on` → on, anything else → off). Unset/blank → `false` for `memory`, `true` for an **explicitly selected** `sqlite`/`postgres`. | must |
| FR-5  | `sqlite` reads `EVER_JOBS_STORE_SQLITE_PATH` (legacy alias `EVER_JOBS_SQLITE_PATH`, named in the plugin's docs). Missing → boot fails with `ERR_STORE_CONFIG_MISSING` naming the variable. `:memory:` is accepted when set explicitly. The parent directory is created if absent. | must |
| FR-6  | `postgres` reads `EVER_JOBS_STORE_DATABASE_URL`, falling back to `DATABASE_URL`. Missing → `ERR_STORE_CONFIG_MISSING`. A non-`postgres://`/`postgresql://` URL → `ERR_STORE_CONFIG_INVALID`. | must |
| FR-7  | `postgres` constructs the Prisma client lazily (only when selected), connects at boot and fails with `ERR_STORE_BACKEND_DOWN` (redacted URL: no user or password) when unreachable, or with an actionable message when `@prisma/client` has not been generated. The client is disconnected on shutdown. | must |
| FR-8  | `StoreModule.forActive` accepts additive `providers` so backend config tokens resolve inside the store module scope. | must |
| FR-9  | Schema: `npm run store:postgres:generate` (Prisma client) and `npm run store:postgres:migrate` (applies `prisma/migrations` via `prisma migrate deploy`, reading the same URL variables). | must |
| FR-10 | The `NODE_ENV=production` memory warning fires only when persistence into memory is actually enabled. | should |
| FR-11 | The Docker image runs `prisma generate` best-effort (a failure cannot fail the build; `postgres` would then fail fast at boot with the generate hint) and ships `openssl` for the Prisma engine on Alpine. | should |
| FR-12 | **The write path works at list-mode size** (review fix, 2026-09-25). A persisted search can carry 20–30 k canonical jobs. `postgres` `upsertMany` writes set-based: one `INSERT … ON CONFLICT (canonical_job_id) DO UPDATE` statement per chunk of `EVER_JOBS_STORE_BATCH_SIZE` rows (default 500), rows de-duplicated (last wins) and sorted by id; no interactive transaction, so Prisma's 5 s interactive-transaction timeout cannot abort it. Atomic per chunk, not per call — a failure part-way leaves earlier chunks written, which is safe because every write is an idempotent upsert. `inserted + updated` always equals the input length (a repeated id counts as an update, exactly as sequential upserts would). | must |
| FR-13 | `IJobObservationStore` gains an optional batch method `putAllMany(entries)` = `putAll` for every entry. `postgres` implements it as one statement per chunk that deletes the observations no longer present and upserts the rest, rewriting a row only when `url`, `observed_at` or `raw_title` changed (no delete-and-reinsert of every observation on every run); entries whose canonical row does not exist are skipped instead of failing the chunk. `sqlite` implements it chunked. `JobsAggregator` uses `putAllMany` when the bound store has it, otherwise calls `putAll` with at most 8 in flight (never one call per job all at once); observation failures stay best-effort and are logged with a count. | must |
| FR-14 | `postgres` constructs the Prisma client with explicit `transactionOptions` (`EVER_JOBS_STORE_TX_TIMEOUT_MS`, default 30000; `EVER_JOBS_STORE_TX_MAX_WAIT_MS`, default 10000) for the interactive transactions that remain (single `putAll`). Invalid values fail the boot with `ERR_STORE_CONFIG_INVALID`. | must |
| FR-15 | `sqlite` `upsertMany` / `putAllMany` never bind more than one row's values per statement (prepared statements; no `IN (…)` over the whole batch, so no `too many SQL variables` at > 32 766 rows), write one transaction per chunk of `EVER_JOBS_STORE_BATCH_SIZE` rows and yield to the event loop (`setImmediate`) between chunks. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Cold start in `memory` mode | unchanged — no Prisma / SQLite code loaded |
| NFR-2 | Secrets | the database URL is never logged; errors print `postgres://host:port/db` only |
| NFR-3 | Persist 10 000+ canonical jobs (+ observations) | `postgres`: succeeds, no P2028; `sqlite`: succeeds at 33 000+ rows, and the event loop runs between chunks |

## 7. Contracts

### 7.1 Env matrix

| `EVER_JOBS_STORE` | `EVER_JOBS_PERSIST_SEARCH` | Backend | Persists? | Required |
| ----------------- | -------------------------- | ------- | --------- | -------- |
| unset | unset | memory | no | — |
| unset | `false` | memory | no | — (our deployment) |
| unset / `memory` | `true` | memory | yes (heap, capped by `EVER_JOBS_STORE_MAX_ROWS`) | — |
| `sqlite` | unset | sqlite | yes | `EVER_JOBS_STORE_SQLITE_PATH` |
| `postgres` | unset | postgres | yes | `EVER_JOBS_STORE_DATABASE_URL` or `DATABASE_URL` |
| `postgres` | `false` | postgres | no (backend still connected) | same |

### 7.2 Interface

```ts
// apps/api/src/config/store-config.ts (pure, no backend imports)
export type KnownStoreId = 'memory' | 'sqlite' | 'postgres';
export function resolveStoreSelection(env): { id: KnownStoreId; explicit: boolean; source: string };
export function resolvePersistSearch(env): boolean;
export function resolveSqlitePath(env): string;            // throws ERR_STORE_CONFIG_MISSING
export function resolvePostgresUrl(env): string;           // throws ERR_STORE_CONFIG_MISSING / _INVALID
export function redactDatabaseUrl(url: string): string;

// apps/api/src/jobs/store-bootstrap.factory.ts
interface ResolvedStoreBootstrap { id; backendClass; explicit: boolean; persistSearch: boolean }
function resolveStoreBootstrap(env?): ResolvedStoreBootstrap;               // selection only
function resolveStoreProviders(id, env?, { loadPrismaClient? }?): Provider[]; // backend config
function connectPostgresStoreClient(url, loadCtor?): Promise<ConnectablePrismaClient>;

// @ever-jobs/plugin
interface StoreModuleForActiveOptions { providers?: ReadonlyArray<Provider> }

// @ever-jobs/models — review fix (FR-13), optional so every existing store still conforms
interface IJobObservationStore {
  putAllMany?(entries: ReadonlyArray<{ canonicalJobId: string; observations: ReadonlyArray<SourceObservation> }>): Promise<void>;
}

// apps/api/src/config/store-config.ts — review fix (FR-12, FR-14, FR-15)
function resolveStoreWriteTuning(env): { batchSize: number; txTimeoutMs: number; txMaxWaitMs: number };
// EVER_JOBS_STORE_BATCH_SIZE (500, 1..5000), EVER_JOBS_STORE_TX_TIMEOUT_MS (30000),
// EVER_JOBS_STORE_TX_MAX_WAIT_MS (10000); non-numeric / out of range → ERR_STORE_CONFIG_INVALID
```

### 7.3 Errors

| Code | Meaning |
| ---- | ------- |
| `ERR_STORE_NOT_FOUND` | unknown backend id (existing) |
| `ERR_STORE_CONFLICT` | `EVER_JOBS_STORE` and `EVER_JOBS_STORE_PLUGIN` disagree |
| `ERR_STORE_CONFIG_MISSING` | the selected backend's required variable is unset |
| `ERR_STORE_CONFIG_INVALID` | the variable is set but unusable (e.g. not a postgres URL) |
| `ERR_STORE_BACKEND_DOWN` | Postgres unreachable at boot, or Prisma client not generated (existing code) |

## 8. Test Plan

- Unit (`store-config.spec.ts`): the matrix above; aliases; conflict; unknown; explicit
  `false` wins over postgres; missing sqlite path / postgres URL messages; URL fallback;
  redaction.
- Unit (`store-bootstrap.factory.spec.ts`): providers per backend; production warning only when
  persisting into memory.
- Module (`store.module.spec.ts`): `providers` option resolves a config token for a backend.
- **Real Postgres** (`store-postgres.boot.int-spec` gated on `EVER_JOBS_TEST_PG_URL`): env →
  `resolveStoreBootstrap` → `StoreModule.forActive` → `JOB_STORE_TOKEN` → `upsertMany` + read
  back; the existing Spec 004 conformance suite against the same database; unreachable URL →
  `ERR_STORE_BACKEND_DOWN` with a redacted message. Exercised against a throwaway PostgreSQL 16
  cluster after `store:postgres:migrate`.
- **Scale (FR-12..FR-15):** `RUN_PG_TESTS` case upserting 10 000 canonical jobs + observations
  through the production client constructor (default transaction options), re-persisting them
  (all `updated`, unchanged observations not rewritten), and a batch with a repeated id;
  SQLite cases at 33 000 rows (red before: `too many SQL variables`) and an event-loop probe
  that must run before `upsertMany` resolves; aggregator tests for `putAllMany` and for the
  bounded `putAll` fallback (never more than 8 in flight).

## 9. Open Questions

- Q-102 — unreachable Postgres at boot: fail fast vs degrade to no persistence; migrations at
  boot vs scripted. Default: fail fast; scripted migrations.

## 10. Decisions

- D-01 — The persist default is a function of the *resolved* backend, computed in one pure
  module that both `configuration.ts` and the bootstrap factory read, so they cannot disagree.
- D-02 — "Explicitly selected" means the variable was set; the default `memory` never implies
  persistence.
- D-03 — Prisma is `require`d lazily so `memory`/`sqlite` boots never load it (NFR-1).
- D-04 — Selection (`resolveStoreBootstrap`) and backend config (`resolveStoreProviders`) are two
  functions, both called at module evaluation in `app.module.ts`. Keeping selection free of
  config lookups preserves every Spec 004 / T12 test verbatim (they select `sqlite` / `postgres`
  without paths or URLs) while the boot still fails before Nest builds anything.
- D-05 — The gated Testcontainers suite accepts `EVER_JOBS_TEST_PG_URL` and refuses any database
  whose name lacks "test" (it truncates). Running it for the first time against a real database
  exposed a harness bug: the migration replay dropped every chunk that *began* with a comment,
  i.e. every `CREATE TABLE`, so the suite could never have passed. Fixed.
- D-06 — (review fix) The Postgres batch writes use raw SQL fed by ONE `jsonb` parameter per
  chunk (`jsonb_to_recordset`) rather than Prisma's per-row `upsert` in an interactive
  transaction. Measured before the fix on PG16 over loopback: 3 000 rows took 3.9 s in one
  transaction and 10 000 rows hit Prisma's default 5 s timeout (P2028); a `putAll` per job,
  all at once, drained the pool. One parameter per chunk also keeps every statement far below
  the 65 535-parameter limit whatever the batch size.
- D-07 — Persistence stays on the response's critical path (awaited). Backgrounding it would
  let a slow store accumulate unbounded pending corpora in the heap across requests; awaiting
  gives natural back-pressure, and after FR-12/FR-13 a 25 k-job persist is seconds. The NDJSON
  heartbeat keeps the connection alive meanwhile (Spec 1721 FR-9).

## 11. References

- `apps/api/src/config/store-config.ts`, `apps/api/src/jobs/store-bootstrap.factory.ts`
- `packages/plugin/src/store/store.module.ts`, `packages/plugins/store-*`
- `scripts/store-postgres.ts`
