# Plan: 5080 — Reserve-overlaps minting policy + duplicate-number lint

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-08-05                         |
| Last updated | 2026-08-05                         |

## 1. Approach

Extend the existing Spec 787 range tooling in place rather than adding a second allocator. Two additive, independent pieces:

1. **Reserve-overlaps policy** in `scripts/spec-ranges.ts`. Add an optional `policy` field to `SpecRange`, a pure `reserveOverlapsAllocation()` computing `{ mint, reserved }` entirely within a band, and an `allocateInRange()` dispatcher that returns the default `max-in-band + 1` (with empty reservations) unless the band's `policy === "reserve-overlaps"`. `next-spec-number.ts` switches to the dispatcher and reports reserved slots on stderr while keeping stdout machine-parseable. `.specify/ranges.json` gains `"policy": "reserve-overlaps"` on the `MakeDeeply/ever-jobs` row only.

2. **Duplicate-number lint** in `scripts/docs-lint.ts`. Read the spec-directory listing once, add a check that groups directories by leading number and fails on any non-allow-listed number with >1 directory. The allow-list is seeded with the inherited cross-fork duplicates `{5024, 5025, 5026}` and doubles as the renumber ledger.

The default-band behavior is unchanged, so upstream (`ever-jobs/ever-jobs`) sees identical output and could adopt both pieces unchanged.

## 2. Phases

### Phase 1 — Reserve-overlaps policy

- Goal: opt-in gap-filling + reserve behavior for MakeDeeply; default untouched.
- Deliverables: `SpecRange.policy`, `Allocation`, `reserveOverlapsAllocation`, `allocateInRange` in `spec-ranges.ts`; `computeNextSpecAllocation` + CLI stderr note in `next-spec-number.ts`; `policy` field in `ranges.json`.
- Exit criteria: `allocateInRange` returns `max-in-band + 1` for the default band and `{ mint: 5080, reserved: [5074,5075,5079] }` for the current fork tree.

### Phase 2 — Duplicate-number lint

- Goal: fail CI on new duplicate spec numbers; allow the 3 inherited.
- Deliverables: `duplicateSpecNumbers` in `DocLintResult`, the check + allow-list, `formatResult` section.
- Exit criteria: current tree passes (only allow-listed dups); a synthetic new duplicate fails.

### Phase 3 — Ceremony + stale-doc fix

- Goal: satisfy repo rules and remove the stale references.
- Deliverables: this spec/plan/tasks; `.specify/README.md` numbering note; `docs/index.md` + `docs/log.md`; drop `5074`/`5075` from the `5077`/`5076` `Related specs` cells.
- Exit criteria: `npm run lint:docs` green; unit tests green; `tsc` clean.

## 3. Packages Touched

| Package                        | Change                                                  |
| ------------------------------ | ------------------------------------------------------- |
| `scripts/spec-ranges.ts`       | `policy` field, `Allocation`, reserve algorithm, dispatcher |
| `scripts/next-spec-number.ts`  | use dispatcher; report reserved slots                   |
| `scripts/docs-lint.ts`         | duplicate-number check + allow-list                     |
| `.specify/ranges.json`         | `policy` on the MakeDeeply row                          |
| `.specify/README.md`           | per-fork numbering note                                 |
| `.specify/specs/5076-*`, `5077-*` | drop stale `5074`/`5075` `Related specs` references  |
| `scripts/__tests__/*`          | new unit tests                                          |

## 4. Dependencies

- Builds on Spec 787 (range registry). No new runtime dependencies.
