# Plan: 1679 — Opt-in per-source diagnostics, and a source-test suite that can finish

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-17   |
| Last updated | 2026-08-17   |

## Approach

Two unrelated problems, both surfaced while reviewing the Spec 5076–5085 release, both cheap to fix
now and awkward later — the API one because a consumer could start reading the field at any time,
the CI one because the suite grows with every plugin batch.

Measure before changing: the row count and payload size come from counting the real registry and
serializing real `Site` tokens, and the CI numbers come from `jest --listTests` plus the timing of a
real 6-hour run, not from estimates.

## Steps

1. **Pure helper first.** `summarizeSourceDiagnostics` lands in `@ever-jobs/models` with no
   controller involvement, so filter/cap/summary semantics are pinned by unit tests independent of
   Nest wiring.
2. **Wire the opt-in.** Two `@Query` params, appended after `@Res()` to avoid shifting a positional
   parameter that direct callers rely on. Applied once, used on both response branches.
3. **Swagger.** Document both params, including *why* it is off by default — the next reader should
   not have to rediscover the 1 651-row measurement.
4. **Shard CI.** Matrix of six with `--shard=N/6`, plus `timeout-minutes` on every job in the file.
5. **Verify the partition** with `--listTests` per shard and check the counts sum to the unsharded
   total. A sharding change that silently drops suites would be worse than the problem it fixes.

## Testing

- `packages/models/__tests__/summarize-source-diagnostics.spec.ts` — filter, cap, summary
  completeness, the >95% payload reduction on a realistic 1 785-row fan-out, degenerate limits, and
  non-mutation of the caller's array.
- `apps/api/src/jobs/__tests__/jobs.controller.spec.ts` — default off, `true`, `all`, the limit and
  its truncation counts, and the falsy/garbage values that must read as off.
- Shard partitioning verified by command, not by assertion, since it is a property of the CI
  invocation rather than of the code.

## Rollout

No migration, no new secret, no image change. `per_source` keeps its name and shape;
`per_source_summary` is additive; the default simply carries no rows. Callers wanting the old
behaviour append `?diagnostics=all&diagnostics_limit=0`.
