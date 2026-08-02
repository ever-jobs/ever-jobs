# Plan: 5073 — Sync upstream `ever-jobs/ever-jobs:develop`

| Field | Value |
| --- | --- |
| Spec ID | 5073 |
| Slug | upstream-develop-sync |
| Status | done |
| Owner | agent |
| Created | 2026-07-27 |
| Last updated | 2026-07-27 |
| Supersedes | (none) |
| Related specs | (none) |


## Phase 1 — Inspect upstream divergence

- List commits behind `origin/develop` vs `ever-jobs/ever-jobs:develop`.
- Categorize into: CI/workflow, lockfile regen, dependabot bumps, plugin fixes.
- Test-merge to identify conflicts.

## Phase 2 — Cherry-pick non-conflicting commits

- Skip merge commits and lockfile-only regeneration commits.
- For dependabot bump commit, apply only `package.json` version changes; drop `@upwork` if present.
- Resolve any `packages/plugins/index.ts` conflicts by unioning additions.

## Phase 3 — Regenerate lockfile

- `rm -rf node_modules package-lock.json && npm install` from the fork's `package.json`.
- Confirm `package-lock.json` reflects the fork's overrides and no `@upwork` stack.

## Phase 4 — Validate

- Run `npx jest` for `site-from-domain`, `jobs.service`, `jobs.controller`, `source-internshala`, `source-simplyhired`.
- Run `npx tsc --noEmit` on `packages/common`, `packages/models`, `apps/api`.
- Run `npm run build`.
- Run `npm audit --audit-level=high`.

## Phase 5 — Commit and PR

- Update `docs/index.md` and `docs/log.md`.
- Commit sync spec, plan, tasks, and regenerated lockfile.
- Push branch and open/merge PR into `develop`.