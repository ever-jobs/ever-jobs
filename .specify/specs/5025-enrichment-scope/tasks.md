# Tasks: 5025 — Scope corpus-signal enrichment to the returned window

- [x] **T01** — Hoist window resolution (`isCsv`, `paginate`, `page`, `pageSize`, `totalPages`, `outputJobs`) above the enrichment block in `JobsController.searchJobs`.
- [x] **T02** — Enrich `outputJobs` instead of `jobs`; preserve liveness-before-legitimacy ordering.
- [x] **T03** — Point the CSV branch at `outputJobs`; keep `format=csv` overriding `paginate` (`paginate = !isCsv && …`).
- [x] **T04** — Return `outputJobs` from both the paginated and the standard-JSON exits; leave `count` / `total_pages` deriving from the full corpus.
- [x] **T05** — Tests: probe-counting liveness stub; page-scoped probe count, exact page-2 URL set, unpaginated full-set, CSV full-set.
- [x] **T06** — `docs/index.md` + `docs/log.md` entries.
- [x] **T07** — Repair the pre-existing stale positional-arg call in the CSV export test (same fix as Spec 5024; both branches carry it so either merge order resolves cleanly).
