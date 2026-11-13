# Spec 1760 — `ever_jobs_sources_total` reports the registered sources

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1760       |
| Status       | done       |
| Area         | Observability of crawls |
| Last updated | 2026-11-11 |

## 1. Problem

`GET /metrics` exposes `ever_jobs_sources_total` ("Total number of supported job
sources"). `MetricsService.onModuleInit` set it to the literal `160` and never
changed it. The registry holds more sources than that and the number moves with
every plugin that is added, so a dashboard or an alert that compares "sources
registered" with "sources that answered" starts from a wrong baseline.

## 2. Scope

- The gauge is read from the plugin registry (`PluginRegistry.size`) on every
  scrape, through a `collect` callback, like `ever_jobs_source_circuit_state`.
- `MetricsService.bindSourceCountSource(() => number)` is the seam;
  `MetricsCircuitBreakerBridge` (already in `JobsModule`, where the registry is
  resolvable) binds it at `OnApplicationBootstrap`, whether or not a breaker is
  bound.
- Without a bound source the gauge reads `0` instead of an invented number.
- A throwing source, a negative or a non-finite count never breaks `/metrics`;
  the last good value stays.

## 3. Non-goals

- No new metric names or labels. No per-category breakdown (a later slice).
- No change to the other gauges, counters or histograms.

## 4. Contract

| Metric                     | Type  | Value                                  |
| -------------------------- | ----- | -------------------------------------- |
| `ever_jobs_sources_total`  | gauge | `PluginRegistry.size` at scrape time; `0` when unbound |

The name and type are unchanged; only the value is now true and the HELP text
reads "Number of registered job sources (source plugins)".

## 5. Test plan

- `apps/api/src/metrics/__tests__/metrics.service.spec.ts`: unbound reads 0 (not
  160); a bound source is re-read on each scrape; a throwing source keeps
  `/metrics` up; negative and `NaN` counts are ignored.
- `apps/api/src/jobs/__tests__/metrics-circuit-breaker.bridge.spec.ts`: the
  registry size is bound with and without a breaker and follows later
  registrations; no registry leaves the gauge at 0.
