# Spec: 5073 — Sync upstream `ever-jobs/ever-jobs:develop` into fork

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Spec ID        | 5073                                    |
| Slug           | upstream-develop-sync                   |
| Status         | completed                               |
| Owner          | agent                                   |
| Created        | 2026-07-27                              |
| Last updated   | 2026-07-27                              |
| Supersedes     | (none)                                  |
| Related specs  | 5072                                    |

## 1. Problem Statement

`MakeDeeply/ever-jobs` `develop` was 12 commits behind `ever-jobs/ever-jobs:develop`. A direct merge was unsafe because upstream commits regenerated `package-lock.json` and reintroduced `@upwork/node-upwork-oauth2` (removed in Spec 5068 for security).

## 2. Goals

- Bring in non-conflicting upstream changes (CI, plugin fixes) without losing the fork's security-related dependency overrides.
- Keep `npm run build`, `npx jest`, and `npx tsc --noEmit` green.
- Maintain the same `npm audit --audit-level=high` posture as Spec 5072.

## 3. Non-Goals

- No full rebase or build-system migration.
- No reintroduction of `@upwork/node-upwork-oauth2`.
- No new runtime features.

## 4. Changes Made

- Cherry-picked upstream CI and plugin commits from `ever-jobs/ever-jobs:develop`:
  - `dff1372f`, `1487c36f` — Node-24 runner action versions.
  - `ce74a898` — grouped Dependabot config.
  - `f728aabf` — minor/patch version bumps in `package.json` (lockfile changes skipped and regenerated locally).
  - `d5257dd2` — `source-internshala` plugin registration and detail fetch.
  - `632cf661` — `source-simplyhired` detail fetch.
  - `20bbff9a`, `6eedb2ed` — ARC runner routing and per-branch Docker tags.
- Skipped upstream lockfile regeneration commits and the merge commits; regenerated `package-lock.json` locally from the fork's `package.json`.
- Preserved fork overrides and the `@upwork` removal.

## 5. Test Plan

- `npx jest` targeted tests for touched packages.
- `npm run build` for `mcp`, `api`, `cli`.
- `npx tsc --noEmit` on `packages/common`, `packages/models`, `apps/api`.
- `npm audit --audit-level=high`.
