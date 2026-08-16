# Spec: 5080 — Reserve-overlaps minting policy + duplicate-number lint

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5080                               |
| Slug           | spec-number-reserve-and-dedup-guard |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-08-05                         |
| Last updated   | 2026-08-05                         |
| Supersedes     | (none)                             |
| Related specs  | 787                                |

## 1. Problem Statement

The fork spec-number range registry (`.specify/ranges.json` + `scripts/next-spec-number.ts` + `scripts/docs-lint.ts`, from Spec 787) reserves a disjoint band per fork so each fork mints only inside its own lane. Two gaps remain:

1. **No renumber targets.** The default allocator mints `max-in-band + 1`. When a band already carries duplicated numbers (see below), there is no mechanism that holds low numbers open as clean targets for a future renumber — a maintainer who wants to renumber a duplicate has to hand-pick a number and hope nothing else took it.

2. **No duplicate-number detection.** `docs-lint` verifies every spec number is inside *some* reserved band and that bands are disjoint, but it never checks that two directories don't share the same leading number. So when `ever-jobs/ever-jobs`'s OOM/memory specs (which had reused this fork's `5024`/`5025`/`5026`) merged into the fork alongside the fork's own `5024`/`5025`/`5026`, both sides' directories now coexist and the lint stayed green. Any future collision — cross-fork merge or hand-numbering — would likewise pass silently.

## 2. Goals

- Add an opt-in, band-local minting policy that fills gaps and reserves the lowest-available numbers as renumber targets for any duplicated numbers, so a renumber always has clean destinations.
- Add a `docs-lint` check that fails on duplicate spec-number directories, with a small allow-list for the numbers already duplicated before the check existed.
- Keep the default (`ever-jobs/ever-jobs`) behavior byte-for-byte unchanged, so the change is upstream-contributable without imposing new numbering on other forks.

## 3. Non-Goals

- Renumbering the inherited `5024`/`5025`/`5026` duplicates (accepted for now; the reserve slots and allow-list keep a future renumber open).
- Changing fork identity resolution, band definitions, or the `SPEC_FORK_REPO` override.
- Validating the free-text `Related specs` metadata field (the two stale `5074`/`5075` references removed in this PR are a one-off doc fix, not a new validator).

## 4. User / Caller Stories

> As a **fork maintainer running `npm run spec:next`**, I want gaps filled and a fixed set of low numbers held open, so that a future renumber of a duplicated spec has clean, pre-computed targets instead of an ad-hoc pick.

> As a **reviewer of a cross-fork sync PR**, I want CI to fail when the merge produces two directories sharing a number, so that collisions are caught at PR time instead of silently accumulating.

## 5. Functional Requirements

| ID    | Requirement                                                                                     | Priority |
| ----- | ----------------------------------------------------------------------------------------------- | -------- |
| FR-1  | A band may carry an optional `"policy"` field in `.specify/ranges.json`; absent/unknown = default `max-in-band + 1`. | must     |
| FR-2  | `"policy": "reserve-overlaps"` mints the lowest-available number in the band after reserving the COUNT lowest-available numbers, where COUNT = Σ(directories_at_number − 1) over the band. | must     |
| FR-3  | The `MakeDeeply/ever-jobs` row opts into `reserve-overlaps`; the `ever-jobs/ever-jobs` row keeps the default. | must     |
| FR-3a | The `MakeDeeply/ever-jobs` band starts at `5001` (not `5000`), so the unused `x000` slot is not offered as available/reserved. | must     |
| FR-4  | Neither policy ever inspects numbers outside `[start, end]` (no global max).                    | must     |
| FR-5  | `docs-lint` fails when two spec directories share a leading number, except numbers in the inherited-duplicate allow-list `{5024, 5025, 5026}`. | must     |
| FR-6  | `spec:next` prints only the mint number on stdout; reserved slots are reported on stderr.       | should   |

## 6. Non-Functional Requirements

| ID     | Requirement                                       | Target                    |
| ------ | ------------------------------------------------- | ------------------------- |
| NFR-1  | Zero runtime deps added (plain fs + arithmetic).  | unchanged                 |
| NFR-2  | Default-band callers see identical output to 787. | byte-for-byte             |

## 7. Contracts

### 7.1 Reserve-overlaps allocation (`scripts/spec-ranges.ts`)

```ts
reserveOverlapsAllocation(existing: number[], r: SpecRange): { mint: number; reserved: number[] }
// COUNT      = Σ(occurrences − 1) over in-band numbers with >1 directory
// available  = in-band numbers with zero directories, ascending (gaps first)
// reserved   = available.slice(0, COUNT)
// mint       = available[COUNT]  (or r.end + 1 when the band can't cover COUNT + 1)

allocateInRange(existing, r) = r.policy === 'reserve-overlaps'
  ? reserveOverlapsAllocation(existing, r)
  : { mint: nextNumberInRange(existing, r), reserved: [] }
```

Current fork tree (band `5001–5999`) → `reserved = [5074, 5075, 5079]`, `mint = 5080` (this spec). The band start was moved `5000 → 5001` in this PR so the never-used `5000` slot isn't surfaced as the lowest-available number.

### 7.2 Duplicate-number lint (`scripts/docs-lint.ts`)

Group `.specify/specs/*` directories by leading number; a number with >1 directory that is not in `DUPLICATE_NUMBER_ALLOWLIST = {5024, 5025, 5026}` is reported as `"<number>: <dir>, <dir>"` and fails the lint.

### 7.3 Errors

| Code                          | Meaning                                              |
| ----------------------------- | ---------------------------------------------------- |
| `Band … is exhausted`         | `mint > band.end` (band can't cover reservations + a mint). |
| duplicate spec number(s)      | Non-allow-listed number carries >1 directory.        |

## 8. Test Plan

- `reserveOverlapsAllocation`: gap-fill + reserve on the real post-merge shape (→ reserved `{5074,5075,5079}`, mint `5080`); no-overlap gap-fill; empty band; out-of-band overlaps ignored; exhaustion → `end + 1`.
- `allocateInRange`: default band returns `max-in-band + 1` with empty reservations; opted-in band dispatches to reserve.
- `computeNextSpecAllocation`: end-to-end over a temp repo with the reserve policy.
- `docs-lint`: flags a new duplicate; allow-lists `5024/5025/5026`; runs with and without `ranges.json`.

## 9. Open Questions

(none)

## 10. Decisions

- Chose an additive per-row `policy` field over hardcoding a fork name in the shared allocator: forks opt into their own strategy from their own registry row, so the change is strictly backward-compatible and upstream can adopt it without changing any other fork's numbering.
- Kept the allocator (prevents *creating* a collision on the normal `spec:next` path) and the lint (catches a collision that slips in via hand-numbering or a cross-fork merge) as complementary layers rather than either/or.
- Allow-listed exactly the three inherited duplicates rather than renumbering them now; the allow-list doubles as the renumber ledger — deleting an entry after a renumber re-tightens the guard.

## 11. References

- `.specify/specs/787-fork-spec-range-reservation/spec.md`
- `.specify/ranges.json`
- `scripts/spec-ranges.ts`, `scripts/next-spec-number.ts`, `scripts/docs-lint.ts`
