# Plan — Spec 5068

| Field | Value |
| --- | --- |
| Spec ID | 5068 |
| Slug | drop-upwork-sdk-dependency |
| Status | done |
| Owner | agent |
| Created | 2026-07-15 |
| Last updated | 2026-07-15 |
| Supersedes | (none) |
| Related specs | (none) |


1. `package.json`: remove `"@upwork/node-upwork-oauth2"` from `dependencies`.
2. `packages/plugins/source-upwork/src/upwork.service.ts`:
   - Replace the two top-level `require('@upwork/...')` calls with a `loadUpworkSdk()`
     helper that `require`s on demand and throws a descriptive error if missing.
   - Call `loadUpworkSdk()` inside `createApiClient` (UpworkApi) and before
     `new Graphql(api)`.
   - Wrap the constructor's `createApiClient` call in try/catch → warn + stay
     unconfigured (no DI-startup crash).
3. `npm install` to prune the lockfile (removes `request`/`tough-cookie`/`uuid` +
   the rest of the deprecated stack; 0 additions).
4. Validate: focused jest, full nx build, `npm ls`/`npm audit`.
5. Docs: `docs/log.md` (top entry) + `docs/index.md` reference.