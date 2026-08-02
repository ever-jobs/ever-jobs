# Plan: 5072 — Migrate transitive `minimatch`/`brace-expansion`

| Field | Value |
| --- | --- |
| Spec ID | 5072 |
| Slug | brace-expansion-transitive-migration |
| Status | done |
| Owner | agent |
| Created | 2026-07-27 |
| Last updated | 2026-07-27 |
| Supersedes | (none) |
| Related specs | (none) |


## Phase 1 — Discover target versions

- Run `npm ls brace-expansion -a` and `npm ls minimatch -a` to enumerate all consumers.
- Use `npm view <pkg>@latest dependencies` and `npm audit --audit-level=high --json` to identify which `minimatch`/`glob` majors are considered safe by the live advisory DB.
- Determine that `minimatch@10.2.5` and `glob@13` are the smallest safe versions.

## Phase 2 — Update root `package.json`

- Bump `eslint` to `^10.8.0` and `@typescript-eslint/*` to `^8.65.0`.
- Bump `testcontainers` to `^12.0.4`.
- Add/change `overrides`:
  - `archiver` → `^8.0.0`
  - `babel-plugin-istanbul` → `^8.0.0`
  - `test-exclude` → `^8.0.0`
  - `glob` → `^13.0.6`
  - `nx` `minimatch` → `10.2.5`
  - `minimatch@^10.0.0` `brace-expansion` → `^5.0.8`
- Remove stale `overrides` that forced vulnerable `glob@10.5.0`.

## Phase 3 — Re-install and inspect

- `rm -rf node_modules package-lock.json && npm install`.
- Run `npm ls minimatch -a` and `npm ls brace-expansion -a` to confirm every chain except `fork-ts-checker-webpack-plugin` uses safe versions.

## Phase 4 — Fix breakages

- If `jest` or `nest` builds fail due to `glob` 13 API changes, pin `glob` back to the newest `10.x` that audit accepts or adjust override.
- In practice, `glob@13` was compatible with `jest-config`/`@jest/reporters`/`jest-runtime` and `nest` asset handling.

## Phase 5 — Validate

- `npx jest` targeted tests pass.
- `npm run build` (mcp+api+cli) passes.
- `npx tsc --noEmit` on `packages/common`, `packages/models`, `apps/api` is clean.
- `npm audit --audit-level=high` returns only the `fork-ts-checker-webpack-plugin` chain as high-severity.

## Phase 6 — Commit and PR

- Update `docs/index.md` and `docs/log.md`.
- Commit with `chore(deps): migrate minimatch/brace-expansion chains to safe majors (Spec 5072)`.
- Push branch and update PR #71 against `develop`.