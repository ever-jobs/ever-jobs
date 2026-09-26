# Tasks: 5145 — eightfold HTTP-error endpoint fallback

- [x] 1. `fetchPage`: per-path try/catch; lastError rethrown when all
  candidate paths throw.
  - AC: 403 on apply/v2 falls through to pcsx instead of aborting.
- [x] 2. Unit tests: apply/v2-403→pcsx-200, all-paths-fail diagnostics,
  5138 200-gate-JSON regression.
  - AC: `npx jest source-ats-eightfold` green.
- [x] 3. `tsc` + `lint:docs` clean; docs index/log; PR to `develop`.
  - AC: PR open, CI green.
