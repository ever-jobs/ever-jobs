# Plan: 5137 — CI unit/e2e shard split

| Field | Value |
| ----- | ----- |
| Status | Implemented |
| Date | 2026-09-21 |

## Steps

1. Edit `.github/workflows/ci.yml`: replace the comment block + `test-sources`
   job; add `test-source-e2e` job after it.
2. Validate YAML parses.
3. Verify partition locally:
   - `npx jest --listTests --testPathPatterns 'packages/plugins/source-' --testPathIgnorePatterns 'e2e-spec' | wc -l` → 1,600
   - `npx jest --listTests --testPathPatterns 'source-.*e2e-spec' | wc -l` → 253
4. Docs: `docs/index.md` row + `docs/log.md` entry.
5. Commit, push, PR to `develop`.

## Risks

- `--testPathIgnorePatterns` replaces the default `/node_modules/` ignore — no
  effect here since test paths are all under `packages/`.
- `source-.*e2e-spec` could match a hypothetical non-plugin path containing
  `e2e-spec` — currently only `packages/plugins/source-*/__tests__/*.e2e-spec.ts`
  match (verified by listTests count).
- Unit suites that secretly hit the network and exceed 30 s would newly fail
  on `testTimeout` — none observed locally; first CI run is the real check.
