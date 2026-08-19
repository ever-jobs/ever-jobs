# Plan: 1684 — the tail cluster whose catch returns a bare empty result

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-19   |
| Last updated | 2026-08-19   |

## Approach

PR 5 of 5, and the awkward remainder by design. The first four passes were uniform; this one is not,
so the work was to find the largest cluster that is *genuinely* mechanical and stop there rather
than force the rest through a regex.

Re-scoped before writing anything, which corrected two earlier claims of my own: the "last catch in
the file" classifier conflated outer with inner catches, and the "~128 accumulator hoists" estimate
described a different (optional) goal — preserving partials — not the one here.

## Steps

1. **Brace-match `scrape()`** and cluster on its own catch, discarding inner and helper catches.
2. Take the largest safe cluster: exactly one catch binding `err` whose block returns
   `new JobResponseDto([])`. 100 services, no restructuring needed.
3. Skip the rest with named reasons, and say how many rather than rounding them away.

## Testing

- **`tsc --noEmit`** is the load-bearing gate here, and it earned that status: it caught the
  spanning-regex bug that every other gate missed (see spec §4.1). 0 errors after the fix.
- **Diff-shape gate** — 100 files, all exactly `+2/-1`, zero outliers.
- **EOL churn gate** — both diff forms report 100.
- **Independent re-check** — a separate script confirms the nearest enclosing catch of every
  inserted call binds `err`. Written deliberately *not* to reuse the codemod's own logic, so it
  cannot share a blind spot with it.
- **Targeted suites** across transformed plugins.

## Rollout

Source-only, no behaviour change beyond the reported reason. Plugins in this cluster still discard
partial results on failure; that is pre-existing and out of scope.

## What remains after this

164 services still report `empty` for real failures: 162 whose `scrape()` has no bare-empty catch
return (their catches sit inside loops or helpers, or they rethrow) and 2 with several such returns.
Enumerated rather than dropped — the honest end state is "1,721 of 1,839 migrated, 164 documented",
not a claim of completeness.
