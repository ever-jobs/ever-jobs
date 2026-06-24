# Tasks: 787 — Fork spec-number range reservation

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Registry + shared helpers

- [x] T01 — Add the registry file
  - **Files:** `.specify/ranges.json`
  - **Acceptance:** two disjoint rows (ever-jobs 1–4999, makedeeply 5000–5999); valid JSON.
  - **Estimate:** 0.5 day

- [x] T02 — Shared band helpers
  - **Files:** `scripts/spec-ranges.ts`, `scripts/__tests__/spec-ranges.spec.ts`
  - **Acceptance:** load/parse, origin→repo normalisation, lookup, overlap detection, band-scoped next-number; unit tests green.
  - **Estimate:** 0.5 day

## Phase 2 — Allocator + lint guard

- [x] T03 — Band-aware allocator
  - **Files:** `scripts/next-spec-number.ts`, `package.json` (`spec:next`)
  - **Acceptance:** prints `max(n in local band)+1`; errors on unregistered fork / exhausted band; `SPEC_FORK_REPO` override works.
  - **Estimate:** 0.5 day

- [x] T04 — docs-lint band checks
  - **Files:** `scripts/docs-lint.ts`, `scripts/__tests__/docs-lint.spec.ts`
  - **Acceptance:** lint fails on overlapping bands and on any spec number outside every band; skipped when registry absent; unit tests green.
  - **Estimate:** 0.5 day

- [x] T05 — Wire into index + log, verify green
  - **Files:** `docs/index.md`, `docs/log.md`
  - **Acceptance:** spec indexed; log entry at top; `npm run build` + `npm run lint:docs` + `npm run test:scripts` all green.
  - **Estimate:** 0.5 day

## Notes

- Tests are written alongside each piece (T02, T04), not batched.
- `docs/log.md` updated in the same commit.
