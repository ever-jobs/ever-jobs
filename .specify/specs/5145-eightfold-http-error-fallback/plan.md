# Plan: 5145 — eightfold HTTP-error endpoint fallback

| Field | Value |
| ----- | ----- |
| Spec ID | 5145 |
| Slug | eightfold-http-error-fallback |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Phases

1. `fetchPage` in `eightfold.service.ts`: per-path try/catch around
   `client.get` + `unwrapPositionsAndCount`; keep `lastError`, continue to
   the next path; rethrow the last error when every path throws.
2. Unit test: apply/v2 403 → pcsx 200 yields positions + resolves
   `jobsPath`; all-paths-fail surfaces diagnostics; 5138's
   200-with-gate-JSON path still falls through.
3. Docs index/log updates, lint/typecheck, PR to `develop`.

## Packages touched

- `packages/plugins/source-ats-eightfold/`
- `.specify/specs/5145-eightfold-http-error-fallback/`
- `docs/index.md`, `docs/log.md`

## Risks

- A tenant that 403s apply/v2 AND fails pcsx now reports the pcsx error —
  acceptable: the last attempt is the actionable failure; behavior only
  differs on the already-broken all-fail path.
