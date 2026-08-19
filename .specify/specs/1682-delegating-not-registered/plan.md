# Plan: 1682 — 699 delegating plugins report a registry miss as `not_registered`

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-19   |
| Last updated | 2026-08-19   |

## Approach

PR 3 of 5, and the first at real scale (1,398 files). Ordered after the generators (Spec 1681) so
the next scaffolded batch cannot reintroduce what this removes.

Two passes, each a validating transform with the same discipline: precondition gate, postcondition
gate, mandatory `--expect`, EOL/BOM preservation, and fail-loud reporting of anything not
understood. Dry run first, always.

## Steps

1. **`scripts/codemod/delegating-diagnostics.ts`** — services. Skips non-delegating and
   already-migrated files by content, requires exactly one anchor, derives the backend label from
   the adjacent logger line, and verifies the output parses before writing.
2. **`scripts/codemod/delegating-diagnostics-specs.ts`** — specs. Reads its backend label from the
   sibling service migrated in pass 1, so the two passes cannot disagree.

## Testing

The census warning shaped this: 1,505 generated specs assert `result.jobs` only and stay green
whatever a plugin reports, so "the suite passed" is not evidence. Verification is therefore layered,
strongest first:

- **Sabotage run** — flip `not_registered` to `empty` in one migrated service; its spec must fail.
  It did (`Expected: "not_registered", Received: "empty"`), proving the new assertion has teeth
  rather than being another vacuous one. Reverted immediately.
- **Diff-shape gate** — every service exactly `+7/-1`, every spec exactly `+4/0`, zero outliers
  across 1,398 files. Any other shape means the transform did something unintended.
- **EOL churn gate** — `git diff --numstat` and `git diff --ignore-all-space --numstat` both report
  1,398 files, proving no line endings or BOMs were rewritten.
- **Type-check** — `tsc --noEmit` clean across the monorepo.
- **Targeted suites** — one package per backend plus the escaped-apostrophe names
  (`rothys`, `raisingcanes`), then a wider spread; all green.

## Rollout

Source-only, no runtime behaviour change for a plugin whose backend resolves normally. A clean
`git revert` restores the previous behaviour. The codemods stay in-tree: they document precisely
what was done, and PRs 4-5 reuse the harness.
