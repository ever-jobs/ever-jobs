# Plan: 1681 — Stop the generators minting the swallowed-error shape

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-19   |
| Last updated | 2026-08-19   |

## Approach

PR 2 of 5, and deliberately ahead of the codemods. Fixing 1,521 generated files while the generators
still emit the defect would mean the next scaffolded batch reintroduces it — the tree would be
correct only until the next run of the hourly task.

Small surface (7 files + 1 new spec), so it can land quickly and unblock PRs 3–5.

## Steps

1. **Greenhouse template** — emit `classifyScrapeError`, return the diagnostic from the catch, and
   return a real `JobResponseDto` on both paths. Pass `jobs`, never `[]`: the catch is outside the
   accumulation loop, so partial results already flow today.
2. **Five delegating templates** — emit `ScrapeDiagnostics` and report the registry miss as
   `not_registered`, the reason Spec 1680 added for exactly this case.
3. **Generated test template** — assert the reason, not just `jobs`.
4. **Export `scaffoldOne`** from the five delegating scaffolders. It was module-private, which is
   the mechanical reason none of them had tests.
5. **One parameterised spec** across all five backends, plus assertions in the existing greenhouse
   spec pinning the emitted catch and return.

## Testing

Three layers, because asserting emitted text alone is weak:

- **Template assertions** — the scaffolder specs now pin `classifyScrapeError(err)`, both return
  shapes, and the absence of `return { jobs };`.
- **Compilation** — ts-jest compiles the scaffolders themselves, which caught a real bug twice: a
  backtick inside an emitted comment terminates the enclosing template literal, surfacing as
  `Cannot find name 'jobs'` / `Cannot find name 'not_registered'`.
- **End-to-end smoke** — scaffold a throwaway plugin into the worktree, run `wire-company-source.ts`
  to add the enum entry, path alias and jest mapper, then run the *generated plugin's own* suite:
  **11/11 pass**, including the new diagnostics assertion. Artifacts reverted afterwards, leaving
  only the intended `scripts/` changes.

That last layer is what actually proves the change: it exercises the generated service against the
generated test, rather than asserting that a string contains a substring.

## Rollout

Generator-only. No runtime code changes, nothing shipped in the API or plugins. New plugins are born
correct; existing ones are migrated by PRs 3–5.
