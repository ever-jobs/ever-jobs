# Plan: 1723 — Server-side gate and cap for liveness probing

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1723       |
| Status       | done       |
| Last updated | 2026-09-24 |

## Approach

1. `resolveLivenessConfig(env)` in `apps/api/src/config/search-config.ts` (pure).
2. `configuration.ts` gains a `liveness` section.
3. The controller's existing `if (parseBool(livenessRaw) && this.livenessChecker)` gains the
   gate; `enrichLiveness` slices to the cap before calling `checkBatch` and writes verdicts
   only onto the probed prefix. The call to `checkBatch` itself is untouched (a concurrent
   branch wraps it in a scrape context), which keeps that rebase trivial.

## Files

| File | Change |
| ---- | ------ |
| `apps/api/src/config/search-config.ts` | `resolveLivenessConfig` |
| `apps/api/src/config/configuration.ts` | `liveness` section |
| `apps/api/src/jobs/jobs.controller.ts` | gate + cap |

## Verification

Config suite; controller liveness-gate suite; existing corpus-signals suite unchanged.
