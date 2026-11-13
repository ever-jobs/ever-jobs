# Plan: 1760 — `ever_jobs_sources_total` reports the registered sources

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1760       |
| Last updated | 2026-11-11 |

## Packages touched

- `apps/api` only: `src/metrics/metrics.service.ts`,
  `src/jobs/metrics-circuit-breaker.bridge.ts`, and their tests.

## Design

`MetricsModule` is global and must not import the plugin registry (the same
boundary argument as Spec 005 / T06), so the count arrives through a bound
closure. The bridge already sits in `JobsModule` and gains an `@Optional()`
`PluginRegistry` dependency; it binds `() => registry.size` before its
breaker early return.

## Risks

- A deployment that scraped the old constant sees the real number. Intended.
- `PluginRegistry` is optional in the bridge, so narrow test bootstraps keep
  working (gauge reads 0).
- Not run in this environment (no shell): see the PR description.
