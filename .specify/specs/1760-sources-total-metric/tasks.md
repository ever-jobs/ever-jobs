# Tasks: 1760 — `ever_jobs_sources_total` reports the registered sources

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1760       |
| Status       | done       |
| Last updated | 2026-11-11 |

- [x] T1 — `MetricsService`: drop the hardcoded 160, add `bindSourceCountSource` and a `collect` on the gauge. Acceptance: `metrics.service.spec.ts` cases.
- [x] T2 — `MetricsCircuitBreakerBridge`: inject `PluginRegistry` (optional) and bind its size. Acceptance: `metrics-circuit-breaker.bridge.spec.ts`.
- [x] T3 — Docs: `docs/index.md`, `docs/log.md`.
- [ ] T4 — (next slice) a per-source "jobs returned" counter, so dashboards can tell a source that answered with nothing from one that answered with postings.
