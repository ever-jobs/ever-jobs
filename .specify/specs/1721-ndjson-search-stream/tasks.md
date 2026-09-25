# Tasks: 1721 — NDJSON search stream, configurable fan-out deadline, per-job dedup key

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1721       |
| Status       | done       |
| Last updated | 2026-09-25 |

- [x] T1 — `formatJobLocation` + `dedupKeyForJob` in `@ever-jobs/common`; `dedup-hybrid` uses the shared formatter. Acceptance: same posting from two sources → same key; equals `canonicalJobId`; class and plain location → same key; dedup-hybrid suites unchanged.
- [x] T2 — `JobPostDto.dedupKey`; aggregator stamps keys on every exit path. Acceptance: aggregator tests for dedup on / off / no engine / empty.
- [x] T3 — `resolveFanoutDeadlineMs` + `configuration.ts`. Acceptance: FANOUT wins over SEARCH; blank / junk falls through; `0` passes through (disables); default 120000.
- [x] T4 — `NdjsonWriter` with back-pressure and close tracking. Acceptance: unit test with a tiny high-water mark writes 1 000 lines without loss; writes after close are dropped.
- [x] T5 — Controller NDJSON branch + heartbeat + error line. Acceptance: controller suite (order, shape equality, pagination ignored, error without `end`, cache hit, heartbeat with fake timers, extra fields pass through).
- [x] T6 — CSV nested arrays; GraphQL `dedupKey`. Acceptance: CSV test sees `dedupKey` column and `a; b` for a nested array.
- [x] T7 — Docs: README "Streaming NDJSON" + "Fan-out deadline", `.env.example`, OpenAPI `format` description, `docs/log.md`, `docs/index.md`, Q-103.

Review fixes (2026-09-25):

- [x] T8 — Initial progress line written synchronously (FR-12). Acceptance: cache-hit stream is `progress, job, end`; the first line is readable while `aggregateRaw` is still pending.
- [x] T9 — `JobsService.assertSearchable` + controller pre-check (FR-13). Acceptance: unresolvable `companyDomain` → `BadRequestException` thrown by the handler, no stream, no fan-out; the service's own message is reused.
- [x] T10 — `SearchRunOptions.isCancelled` + controller wiring (FR-14). Acceptance: service test — cancelled after the first source → no further scraper called, `cancelled: true`, `cancelled_skipped` metric; controller test — after `close`, no cache write and no dedup.

Integration fix (2026-09-25):

- [x] T11 — Crawl completeness on the `end` line (FR-15..FR-18). `search-completeness.ts` (record, stop reasons, cache endpoint, read-back guard); `FanoutDeadlineError` for the mid-flight abandonment; the fan-out tracks the first bound, skipped and abandoned sources and the failures of the sources that ran, and returns `completeness`; the controller caches the record next to the raw set, reports it on the `end` line, re-runs the fan-out for an NDJSON hit without a valid record, and omits the fields if a service reports none. Acceptance: the service, controller and helper suites listed in spec §8 (FR-15..FR-18 bullet); a mutation that drops the `end`-line fields fails 7 controller tests, one that drops the abandonment's stop reason fails the service test, and removing the "deadline passed" flag fails the frozen-clock test; README "Streaming NDJSON" and the OpenAPI `format` description document the fields and the consumer rule.

Review fixes, second round (2026-09-25):

- [x] T12 — One shared key input (FR-10). `canonicalKeyInputForJob` in `@ever-jobs/common` builds
  `{ title, company, location, locations, isRemote }`; `DedupHybridService` and `dedupKeyForJob`
  both use it. Acceptance: `dedupKeyForJob` equals the engine `canonicalJobId` for a remote
  country-only posting, a multi-location posting and a mixed batch; reverting `dedupKeyForJob` to
  the 3-field input fails 5 tests; FR-10 records the one-time key change for those postings.
- [x] T13 — One cache entry (FR-19). `search-cache.ts` (`search-v2`, `toCachedSearch`, `readCachedSearch`); `runSearch` reads and writes `{ jobs, completeness? }` once. Acceptance: with a real `lruSize: 1` store page 2 is a cache hit and NDJSON after JSON needs no fan-out; the FR-17 two-entry write fails both tests; the two develop controller tests that asserted the bare-array value now assert `{ jobs }`.
