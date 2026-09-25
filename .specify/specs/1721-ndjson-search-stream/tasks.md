# Tasks: 1721 — NDJSON search stream, configurable fan-out deadline, per-job dedup key

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1721       |
| Status       | done       |
| Last updated | 2026-09-24 |

- [x] T1 — `formatJobLocation` + `dedupKeyForJob` in `@ever-jobs/common`; `dedup-hybrid` uses the shared formatter. Acceptance: same posting from two sources → same key; equals `canonicalJobId`; class and plain location → same key; dedup-hybrid suites unchanged.
- [x] T2 — `JobPostDto.dedupKey`; aggregator stamps keys on every exit path. Acceptance: aggregator tests for dedup on / off / no engine / empty.
- [x] T3 — `resolveFanoutDeadlineMs` + `configuration.ts`. Acceptance: FANOUT wins over SEARCH; blank / junk falls through; `0` passes through (disables); default 120000.
- [x] T4 — `NdjsonWriter` with back-pressure and close tracking. Acceptance: unit test with a tiny high-water mark writes 1 000 lines without loss; writes after close are dropped.
- [x] T5 — Controller NDJSON branch + heartbeat + error line. Acceptance: controller suite (order, shape equality, pagination ignored, error without `end`, cache hit, heartbeat with fake timers, extra fields pass through).
- [x] T6 — CSV nested arrays; GraphQL `dedupKey`. Acceptance: CSV test sees `dedupKey` column and `a; b` for a nested array.
- [x] T7 — Docs: README "Streaming NDJSON" + "Fan-out deadline", `.env.example`, OpenAPI `format` description, `docs/log.md`, `docs/index.md`, Q-103.

Review fixes (2026-09-25):

- [ ] T8 — Initial progress line written synchronously (FR-12). Acceptance: cache-hit stream is `progress, job, end`; the first line is readable while `aggregateRaw` is still pending.
- [ ] T9 — `JobsService.assertSearchable` + controller pre-check (FR-13). Acceptance: unresolvable `companyDomain` → `BadRequestException` thrown by the handler, no stream, no fan-out; the service's own message is reused.
- [ ] T10 — `SearchRunOptions.isCancelled` + controller wiring (FR-14). Acceptance: service test — cancelled after the first source → no further scraper called, `cancelled: true`, `cancelled_skipped` metric; controller test — after `close`, no cache write and no dedup.
