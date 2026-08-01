# Tasks: 5026 — Bounded search fan-out

- [x] **T01** — Extract the per-source closure into `JobsService.scrapeOne(site, scraper, input)`; body unchanged.
- [x] **T02** — `DEFAULT_SEARCH_CONCURRENCY` (64) and `DEFAULT_SEARCH_DEADLINE_MS` (120 000) constants with rationale.
- [x] **T03** — `search.concurrency` / `search.deadlineMs` in `apps/api/src/config/configuration.ts` (`EVER_JOBS_SEARCH_CONCURRENCY`, `EVER_JOBS_SEARCH_DEADLINE_MS`).
- [x] **T04** — Replace the unbounded `Promise.allSettled(map(...))` with a shared-cursor worker pool writing results by input index.
- [x] **T05** — Deadline check before starting each item; drain the remainder as skipped; `warn` log with the count.
- [x] **T06** — `ever_jobs_scraper_requests_total{status="deadline_skipped"}`.
- [x] **T07** — Repair `jobs.service.spec.ts`'s `createService` (stub `registry` / `configService` / `metrics`; the old `scraperMap` field is no longer read by the service).
- [x] **T08** — Tests: concurrency ceiling, serialisation at 1, deadline sheds work, `deadlineMs=0` disables, failing source does not stall peers.
- [x] **T09** — `docs/index.md` + `docs/log.md` entries.
- [x] **T10** — ~~Follow-up: drop `ScraperInputDto`'s `siteType` constructor default.~~ **Investigated and closed as WON'T DO (Q-OOM-1, 2026-07-31).** Hust never sets `siteType`, and its only consumer of the API is a background *corpus sync* — which wants breadth, so narrowing would silently shrink the corpus ~150×. The ATS-exclusion variant was also rejected: 146/176 ATS plugins do early-return empty without a slug, but `source-ats-deel` is a genuine slug-less org-wide source (gated on `DEEL_API_TOKEN`, not a slug) and ~27 others are unverified. With the concurrency bound in place the residual cost is CPU/socket churn, not memory. Full evidence in `docs/questions.md`.
- [x] **T11b** — CI: replace the `Verify Docker health` flat `sleep 10` with a bounded poll (45 × 2s) plus a container-died fast-exit. Bootstrap instantiates ~1 800 plugin modules and DEBUG-logs one line per source; on a slower runner that exceeds 10s, so the step failed with `HTTP 000` (connection refused — not listening yet) rather than a real health failure. Flake gets strictly worse with each plugin batch.
- [ ] **T12** — If ATS-exclusion is ever revisited, add a per-plugin `requiresCompanySlug` flag to the plugin metadata so the registry filters on fact rather than on the `source-ats-*` naming convention.
- [ ] **T11** — Follow-up: propagate an `AbortSignal` from `request.on('close')` into the fan-out so client disconnects cancel in-flight work.
