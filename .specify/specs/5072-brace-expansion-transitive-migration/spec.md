# Spec: 5072 — Migrate transitive `minimatch`/`brace-expansion` to patched versions

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Spec ID        | 5072                                    |
| Slug           | brace-expansion-transitive-migration    |
| Status         | completed                               |
| Owner          | agent                                   |
| Created        | 2026-07-27                              |
| Last updated   | 2026-07-27                              |
| Supersedes     | (none)                                  |
| Related specs  | 5071                                    |

## 1. Problem Statement

`npm audit --audit-level=high` reported `brace-expansion` because its advisory (`<=5.0.7`) permanently flags the `1.x` and `2.x` copies used by `minimatch@3`/`minimatch@5`/`minimatch@9.0.9`. Later audit data also flagged `minimatch` versions `2.0.0 - 10.2.2` for ReDoS and dependency-on-vulnerable-`brace-expansion`. The safe versions are `minimatch@10.2.5` (uses `brace-expansion@^5.0.5`, patched to `5.0.8`) or `minimatch@10.0.3/10.1.2` (uses `@isaacs/brace-expansion`).

## 2. Goals

- Reduce `brace-expansion`/`minimatch` high-severity advisories as far as possible without changing the build system.
- Upgrade dev/build dependencies or override their transitive `minimatch`/`glob` chains to safe major versions.
- Keep source code and runtime behaviour unchanged.
- Keep `npm run build`, `npx jest`, and `npx tsc --noEmit` green.

## 3. Non-Goals

- No runtime dependency major bumps.
- No `--force` or `npm audit fix --force`.
- No migration away from `@nestjs/cli` webpack builds (that is the remaining blocker).
- No changes to source logic.

## 4. Changes Made

Root `package.json`:

- `eslint` → `^10.8.0` and `@typescript-eslint/*` → `^8.65.0` so `eslint` uses `minimatch@^10.2.5`.
- `testcontainers` → `^12.0.4`.
- `overrides`:
  - `archiver` → `^8.0.0`
  - `babel-plugin-istanbul` → `^8.0.0`
  - `test-exclude` → `^8.0.0`
  - `glob` → `^13.0.6`
  - `nx` `minimatch` → `10.2.5`
  - `minimatch@^10.0.0` `brace-expansion` → `^5.0.8`
  - Removed the `@nestjs/cli` `glob: 10.5.0` and `archiver-utils` `glob` overrides.

## 5. Remaining Blocker

`@nestjs/cli` depends on `fork-ts-checker-webpack-plugin@9.1.0`, which is pinned to `minimatch@3`. There is no newer release of `fork-ts-checker-webpack-plugin` and no way to force `minimatch@10` into it without breaking its default import. Removing or replacing `@nestjs/cli` would require a build-system change (e.g. `swc`/`tsc` instead of webpack), which is out of scope for this spec.

## 6. Test Plan

- `npm install` succeeds.
- `npx jest` targeted tests pass.
- `npm run build` passes.
- `npx tsc --noEmit` on `packages/common`, `packages/models`, `apps/api` is clean.
- `npm audit --audit-level=high` returns only the `fork-ts-checker-webpack-plugin` chain as high-severity.
