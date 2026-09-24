# Tasks: 1722 — Store backend selection that actually works from the environment

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1722       |
| Status       | done       |
| Last updated | 2026-09-24 |

- [x] T1 — `store-config.ts` with aliases, conflict, persist default, resolvers, redaction. Acceptance: matrix unit tests (memory default off; `PERSIST=true` memory on; postgres selected → on; explicit `false` wins; missing URL fails fast naming both variables).
- [x] T2 — `configuration.ts` reads `resolvePersistSearch`. Acceptance: our deployment env → `false`.
- [x] T3 — `StoreModule.forActive({ providers })`. Acceptance: module test resolves a backend that injects a config token.
- [x] T4 — Bootstrap factory providers (sqlite path, postgres lazy Prisma + connect + disconnect) and production warning gated on persistence. Acceptance: factory tests.
- [x] T5 — `scripts/store-postgres.ts` + npm scripts. Acceptance: `migrate` applied `0_init` to a real PostgreSQL 16 database.
- [x] T6 — Postgres harness via `EVER_JOBS_TEST_PG_URL`; boot-path integration test. Acceptance: conformance + boot tests green against the throwaway cluster; unreachable URL → `ERR_STORE_BACKEND_DOWN`, password absent from the message.
- [x] T7 — Dockerfile best-effort generate + `openssl`. Acceptance: reviewed; not built in this lane (recorded).
- [x] T8 — Docs: README "Storage backends" with the env matrix and forker walkthrough, `.env.example`, `docs/log.md`, `docs/index.md`, Q-102.
