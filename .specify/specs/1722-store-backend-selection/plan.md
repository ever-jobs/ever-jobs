# Plan: 1722 — Store backend selection that actually works from the environment

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1722       |
| Status       | done       |
| Last updated | 2026-09-24 |

## Approach

1. **Pure config module** `apps/api/src/config/store-config.ts`: alias table, selection with
   conflict detection, persist default, per-backend required-variable resolvers, URL redaction,
   error codes. No imports of backend packages.
2. **`configuration.ts`**: `store.persistSearch` = `resolvePersistSearch(process.env)`; adds
   `store.backend` for observability.
3. **`StoreModule.forActive`**: additive `providers` option spread into the dynamic module.
4. **Bootstrap factory**: returns `providers` per backend —
   - sqlite: `STORE_SQLITE_DRIZZLE_CONFIG` = `{ databaseUrl: path }`, creating the directory;
   - postgres: an async factory that lazily loads `@prisma/client`, constructs
     `new PrismaClient({ datasourceUrl })`, `$connect()`s (redacted `ERR_STORE_BACKEND_DOWN` on
     failure), and a lifecycle provider that `$disconnect()`s on shutdown.
   Required variables are resolved synchronously at module evaluation so a missing value fails
   before Nest builds anything.
5. **Scripts**: `scripts/store-postgres.ts` (`generate` | `migrate`) resolving the same URL
   variables and shelling out to the local `prisma` CLI; npm scripts
   `store:postgres:generate` / `store:postgres:migrate`.
6. **Postgres test harness**: the gated conformance suite accepts `EVER_JOBS_TEST_PG_URL` as an
   alternative to Testcontainers; a new boot-path integration test.
7. **Dockerfile**: best-effort `prisma generate` in the builder; `openssl` in the runtime.

## Files

| File | Change |
| ---- | ------ |
| `apps/api/src/config/store-config.ts` | new |
| `apps/api/src/config/configuration.ts` | persist default |
| `apps/api/src/jobs/store-bootstrap.factory.ts` | aliases, providers, warning |
| `apps/api/src/app.module.ts` | pass `providers` |
| `packages/plugin/src/store/store.module.ts` | `providers` option |
| `scripts/store-postgres.ts`, `package.json` | schema scripts |
| `packages/plugins/store-postgres-prisma/__tests__/*` | URL-based harness, boot test |
| `Dockerfile` | generate + openssl |

## Risks

- **Our deployment** — covered by a test asserting unset store + `PERSIST=false` → memory, no
  persistence, no providers, and by the fact that no new code runs for `memory`.
- **Dockerfile** — cannot be built in this workstation lane; the generate step is `|| echo` so
  it cannot fail the build. Flagged as unverified in the handover.

## Verification

Unit suites; real PostgreSQL 16 throwaway cluster (initdb on a free port) running
`store:postgres:migrate`, the boot test and the conformance suite; `tsc`.
