# Spec: 787 — Fork spec-number range reservation

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 787                                |
| Slug           | fork-spec-range-reservation        |
| Status         | accepted                           |
| Owner          | agent                              |
| Created        | 2026-06-23                         |
| Last updated   | 2026-06-23                         |
| Supersedes     | (none)                             |
| Related specs  | (none)                             |

## 1. Problem Statement

Spec numbers are minted by the GitHub Spec Kit CLI as `max(existing spec
numbers) + 1`. That rule is **fork-blind**: when a downstream fork mints specs
and those specs later flow back upstream (or between forks), both sides keep
counting off the same shared maximum and produce **colliding numbers**. The same
collision already occurred once in this lineage (two forks independently using
742–759), which required a disruptive renumber to untangle.

`max+1` only keeps lanes separate while sync is strictly one-directional *and*
one fork happens to own the global maximum — neither assumption holds once a
maintainer wants to merge multiple forks' work back together.

## 2. Goals

- Let each fork **reserve a disjoint band** of spec numbers, owned by the
  upstream repo, so numbering never collides under merges in any direction.
- Make the reservation **code-enforced**, not honour-system: CI fails if a spec
  is minted outside a registered band, and if two bands overlap.
- Keep the registry **conflict-free to merge**: appending a fork's row must
  never touch another fork's row.
- Provide a band-aware **next-number allocator** so contributors mint correct
  numbers without memorising their band.

## 3. Non-Goals

- Changing the external Spec Kit CLI itself (we do not vendor it). The allocator
  here is a convenience + the lint check is the binding guard.
- Renumbering any existing specs. Upstream's existing specs all fall within the
  default `1–4999` band, so no renumber is required.
- Reserving bands for forks that have not requested one.

## 4. User / Caller Stories

> As a **fork maintainer**, I want to reserve a numeric band by appending one
> row upstream, so that my specs never collide with anyone else's after a merge.

> As a **contributor**, I want `npm run spec:next` to print the right next
> number for my fork, so that I do not have to know my band by heart.

> As a **reviewer**, I want CI to reject a spec minted outside its band, so that
> the reservation cannot be bypassed by hand.

## 5. Functional Requirements

| ID    | Requirement                                                                 | Priority |
| ----- | -------------------------------------------------------------------------- | -------- |
| FR-1  | A committed `.specify/ranges.json` maps each fork (`repo`) to `[start,end]`. | must     |
| FR-2  | `scripts/next-spec-number.ts` derives the fork from `git remote get-url origin`, finds its band, and prints `max(n in band)+1` (or `start` if empty). | must     |
| FR-3  | `SPEC_FORK_REPO=owner/repo` overrides origin detection (mirrors / CI).      | should   |
| FR-4  | `docs-lint` fails when two registered bands overlap.                        | must     |
| FR-5  | `docs-lint` fails when any spec directory number falls outside every band.  | must     |
| FR-6  | The allocator errors when the fork is unregistered or its band is exhausted.| must     |
| FR-7  | Registry checks are **skipped** when `.specify/ranges.json` is absent (backwards compatible). | must     |

## 6. Non-Functional Requirements

| ID     | Requirement                            | Target            |
| ------ | -------------------------------------- | ----------------- |
| NFR-1  | Registry helpers add zero runtime deps | fs + string only  |
| NFR-2  | Merge safety of the registry           | one row per fork; appends never collide |
| NFR-3  | docs-lint runtime impact               | negligible (one readdir) |

## 7. Contracts

### 7.1 API / Interface

```ts
// scripts/spec-ranges.ts
export interface SpecRange { fork: string; repo: string; start: number; end: number; }

export function loadRanges(repoRoot: string): Promise<SpecRange[] | null>;
export function parseOriginRepo(url: string): string | null;          // -> "owner/repo"
export function findRangeForRepo(ranges: SpecRange[], repo: string): SpecRange | null;
export function findOverlaps(ranges: SpecRange[]): string[];          // [] when disjoint
export function rangeForNumber(ranges: SpecRange[], n: number): SpecRange | null;
export function nextNumberInRange(existing: number[], r: SpecRange): number;

// scripts/next-spec-number.ts
export function computeNextSpecNumber(repoRoot: string): Promise<number>;
```

`.specify/ranges.json`:

```json
{
  "ranges": [
    { "fork": "ever-jobs",  "repo": "ever-jobs/ever-jobs", "start": 1,    "end": 4999 },
    { "fork": "makedeeply", "repo": "MakeDeeply/ever-jobs", "start": 5000, "end": 5999 }
  ]
}
```

### 7.2 Errors

| Code / message                          | Meaning                                  |
| --------------------------------------- | ---------------------------------------- |
| `No reserved range for "<repo>" …`      | Fork has no row in the registry.         |
| `Band "<fork>" […] is exhausted …`      | `max(n in band)+1 > end`.                |
| `Could not determine the origin repo …` | No origin remote and no `SPEC_FORK_REPO`.|

## 8. Test Plan

- Unit (`scripts/__tests__/spec-ranges.spec.ts`): URL parsing (https/ssh/proxy),
  band lookup, overlap detection, band-scoped next-number, exhaustion, missing
  registry → null.
- Unit (`scripts/__tests__/docs-lint.spec.ts`): out-of-band spec flagged,
  overlapping bands flagged, in-band passes, checks skipped when registry absent.
- Manual: `npm run spec:next` prints `787` here (ever-jobs band) and `5018` in
  MakeDeeply/ever-jobs (makedeeply band).

## 9. Open Questions

(none — band layout and identity scheme settled below.)

## 10. Decisions

- **Identity is derived from `origin`, never committed.** A committed "I am
  fork X" marker would conflict on every merge; deriving from the remote keeps
  the tree conflict-free.
- **Band width 1000.** Generous for the foreseeable future; a fork that exhausts
  its band reserves another row.
- **Upstream owns the registry.** It only works as a single authoritative file
  on the common ancestor; forks inherit it on sync.

## 11. References

- `scripts/spec-ranges.ts`, `scripts/next-spec-number.ts`, `scripts/docs-lint.ts`
- `.specify/ranges.json`
