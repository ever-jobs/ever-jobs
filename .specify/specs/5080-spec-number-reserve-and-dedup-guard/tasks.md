# Tasks: 5080 — Reserve-overlaps minting policy + duplicate-number lint

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Reserve-overlaps policy

- [x] T01 — Add `policy` field + reserve algorithm + dispatcher
  - **Files:** `scripts/spec-ranges.ts`, `.specify/ranges.json`
  - **Acceptance:**
    - `SpecRange.policy?: string`; `Allocation { mint, reserved }` exported
    - `reserveOverlapsAllocation` fills gaps, reserves COUNT lowest-available, mints next; never uses a global max; returns `end + 1` on exhaustion
    - `allocateInRange` returns default `max-in-band + 1` (empty reserved) unless `policy === 'reserve-overlaps'`
    - `MakeDeeply/ever-jobs` row carries `"policy": "reserve-overlaps"`; `ever-jobs/ever-jobs` row unchanged
  - **Estimate:** 0.5 day

- [x] T02 — Wire the allocator CLI to the dispatcher
  - **Files:** `scripts/next-spec-number.ts`
  - **Acceptance:**
    - `computeNextSpecAllocation` returns `{ mint, reserved }`; `computeNextSpecNumber` returns `mint`
    - stdout prints only the mint number; reserved slots printed on stderr
  - **Estimate:** 0.25 day

## Phase 2 — Duplicate-number lint

- [x] T03 — Add duplicate spec-number check + allow-list
  - **Files:** `scripts/docs-lint.ts`
  - **Acceptance:**
    - `DocLintResult.duplicateSpecNumbers`; check groups dirs by number
    - non-allow-listed number with >1 dir fails; `{5024,5025,5026}` allow-listed
    - runs independent of `.specify/ranges.json`; `formatResult` renders a section
  - **Estimate:** 0.5 day

## Phase 3 — Ceremony, stale-doc fix, tests

- [x] T04 — Remove stale `Related specs` references
  - **Files:** `.specify/specs/5076-browserpool-headful-persistent-context/spec.md`, `.specify/specs/5077-gusto-hosted-headful-parsing/spec.md`
  - **Acceptance:** drop `5075` (5076) and `5074` (5077) — neither number has a spec dir on `develop`
  - **Estimate:** 0.1 day

- [x] T05 — Unit tests
  - **Files:** `scripts/__tests__/spec-ranges.spec.ts`, `scripts/__tests__/docs-lint.spec.ts`
  - **Acceptance:** reserve/dispatch/allocation + duplicate-lint/allow-list cases green
  - **Estimate:** 0.5 day

- [x] T06 — Docs: numbering note, index, log
  - **Files:** `.specify/README.md`, `docs/index.md`, `docs/log.md`
  - **Acceptance:** README `## Numbering` describes per-fork bands + reserve policy; index lists 5080; log has a newest-at-top entry
  - **Estimate:** 0.25 day

## Notes

- `npm run lint:docs`, `npm run test:scripts`, and `tsc` must all pass before PR.
