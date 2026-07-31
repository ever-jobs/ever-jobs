# Tasks: 5024 — Bounded store retention

- [x] **T01** — `DEFAULT_ROW_CAP`, `STORE_MAX_ROWS_ENV_VAR`, `resolveRowCap(env)` in `store-memory.service.ts`.
- [x] **T02** — `rowCap` field, `rowCapacity` getter, `setRowCap()` seam.
- [x] **T03** — `trimRows()` (`while` loop, cascades into `observations`); call from `upsert` and once per `upsertMany`.
- [x] **T04** — Re-export the new symbols from `packages/plugins/store-memory/src/index.ts`.
- [x] **T05** — Unit tests: default/override/junk matrix, oldest-first trim, over-cap batch, observation cascade, `setRowCap` validation, idempotent re-upsert.
- [x] **T06** — `store.persistSearch` + `store.maxRows` in `apps/api/src/config/configuration.ts`.
- [x] **T07** — Thread `persist` through `JobsController.searchJobs` (`ConfigService` dep).
- [x] **T08** — Thread `persist` through `JobsResolver.searchJobs` (`ConfigService` dep).
- [x] **T09** — Production `memory`-backend warning in `resolveStoreBootstrap`.
- [x] **T10** — `docs/index.md` + `docs/log.md` entries.
- [ ] **T11** — Follow-up (separate spec): wire a durable backend so `EVER_JOBS_STORE=postgres` is selectable without a fail-fast on `STORE_POSTGRES_PRISMA_CONFIG`.
