# Plan: 1685 — the tail cluster returning the accumulator without a reason

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-19   |
| Last updated | 2026-08-19   |

## Approach

The last mechanical pass. Everything from here is hand work, so the job was to draw that line
honestly rather than push a codemod past the point where it earns its keep.

Re-clustered the 164 remaining services first, which changed the picture materially: 5 of them
(cluster A) were never broken — they let the error propagate and the fan-out's `rejected` branch
already classifies it. Counting those as "unmigrated" would have been wrong.

## Steps

1. Cluster by what the last catch of the brace-matched `scrape()` body does.
2. Transform cluster D (126) — the SmartRecruiters shape, partial results with no signal.
3. Attempt cluster B (30). Abandon it on evidence (see below).
4. Enumerate what is left instead of rounding it away.

## Testing

- **`tsc --noEmit`** — the decisive gate again. It is what rejected the cluster-B attempt, exactly as
  it caught the Spec 1684 scope bug. 0 errors on the shipped change.
- **Diff-shape gate** — 126 files, all `+5/-1`, zero outliers.
- **EOL churn gate** — both diff forms report 126.
- **Independent re-check** — nearest enclosing catch of every inserted call binds `err`; written not
  to reuse the codemod's logic, so it cannot share a blind spot.
- **Targeted suites** green.

## Why cluster B was abandoned

Its catch has no return, so the reason must reach the terminal return via a variable — declare,
assign, use. The codemod's own gate rejected 31 of 37 candidates as ambiguous (more than one `err`
catch). Of the 6 it accepted, `tsc` rejected **3** for a misplaced declaration.

Six files, half of them wrong, from a transform unlike any of the others. Reverted in full and the
tool deleted, because leaving a half-working codemod in `scripts/codemod/` invites someone to trust
it later. These want hand edits.

## Rollout

Source-only. Cluster D plugins already returned their partial results; this only attaches the
reason, and Spec 1680's inference reports that as `partial` rather than `ok`.
