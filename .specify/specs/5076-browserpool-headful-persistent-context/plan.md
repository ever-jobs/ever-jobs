# Plan: 5076 — BrowserPool headful / persistent-context opt-in

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-04                         |
| Last updated | 2026-08-04                         |

## 1. Approach

Add two optional fields to `BrowserPageOptions` so callers can request a persistent context and/or a headful browser. `BrowserPool` decides between `chromium.launch()` (current default) and `chromium.launchPersistentContext()` based on those options. The implementation stays inside `packages/common/src/browser/browser-pool.ts` and its unit tests.

## 2. Phases

### Phase 1 — Extend options and routing

- Goal: `BrowserPageOptions` accepts `headful` and `userDataDir`, and `BrowserPool.getPage` uses `launchPersistentContext` when either is set.
- Deliverables: updated `browser-pool.ts`, no breaking changes.
- Exit criteria: existing tests still pass; new unit tests confirm both code paths.

### Phase 2 — Tests and docs

- Goal: add unit tests for the new routing and update `docs/index.md` / `docs/log.md`.
- Deliverables: `__tests__` in `packages/common/src/browser/`, spec docs.
- Exit criteria: `npx jest packages/common` and `npx tsc --noEmit -p packages/common/tsconfig.json` pass.
