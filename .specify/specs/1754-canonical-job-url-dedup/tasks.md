# Tasks — Spec 1754

- [x] T1 `canonicalJobUrl` + tests (tracking, host case, port, sorting, fragment, invalid input).
- [x] T2 `dropDuplicateJobUrls` + tests (first seen wins, shared URL, no URL, immutability).
- [x] T3 Aggregator switch (`dedupByUrl`, `EVER_JOBS_DEDUP_BY_URL`) + skip log + `urlDuplicatesSkipped`.
- [x] T4 Aggregator tests (off by default, option, env, with engine).
- [ ] T5 Run the new suites in CI (not run in the authoring session).
- [ ] T6 Follow-up: request parameter and response metric.
