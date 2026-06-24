# Plan: 787 — Fork spec-number range reservation

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | spec.md                            |
| Created      | 2026-06-23                         |
| Last updated | 2026-06-23                         |

## 1. Approach

The reservation is three small, dependency-free pieces that build on each other.
First, a committed registry file `.specify/ranges.json` records one row per fork
mapping its `origin` repo to an inclusive `[start, end]` band. Because rows are
keyed by distinct repo, two forks can append their rows independently and the
file never produces a merge conflict — it is the single coordination point, owned
by the upstream repo.

Second, a shared helper module `scripts/spec-ranges.ts` centralises all band
logic: load + parse the registry, normalise a git remote URL to `owner/repo`,
look up a fork's band, detect overlaps, and compute the band-scoped next number.
Keeping this in one module means the allocator and the lint guard cannot drift.

Third, `scripts/next-spec-number.ts` is the contributor-facing allocator: it
derives the local fork from `git remote get-url origin` (overridable via
`SPEC_FORK_REPO`), finds its band, and prints `max(n in band)+1`. Finally,
`scripts/docs-lint.ts` gains two CI-enforced checks — overlapping bands and any
spec number outside every registered band — so the reservation cannot be
bypassed by hand. All registry checks are skipped when the file is absent, so the
change is backwards compatible.

## 2. Phases

### Phase 1 — Registry + shared helpers

- Goal: `.specify/ranges.json` + `scripts/spec-ranges.ts`.
- Deliverables: registry file with the two rows; pure helper functions.
- Exit criteria: unit tests for parsing/overlap/next-number pass.

### Phase 2 — Allocator + lint guard

- Goal: `scripts/next-spec-number.ts` (+ `spec:next` npm script) and the two new
  `docs-lint` checks.
- Deliverables: band-aware allocator; lint failures on overlap / out-of-band.
- Exit criteria: `npm run build`, `npm run lint:docs`, `npm run test:scripts`
  all green.

## 3. Packages Touched

| Package                        | Change                                       |
| ------------------------------ | -------------------------------------------- |
| `.specify`                     | new `ranges.json`; new spec triad 787        |
| `scripts`                      | new `spec-ranges.ts`, `next-spec-number.ts`; extend `docs-lint.ts` |
| `package.json`                 | add `spec:next` script                       |

## 4. Dependencies

| Library | Version | Rationale                                   |
| ------- | ------- | ------------------------------------------- |
| (none)  | —       | Uses only `fs` + `child_process` + strings. |

## 5. Risks & Mitigations

| Risk                                       | Likelihood | Impact | Mitigation                          |
| ------------------------------------------ | ---------- | ------ | ----------------------------------- |
| Origin URL undetectable (CI/mirror)        | M          | M      | `SPEC_FORK_REPO` override           |
| Registry adopted only downstream           | M          | H      | Land upstream first; forks inherit  |
| Band exhaustion                            | L          | M      | 1000-wide bands; reserve another row|

## 6. Rollback Plan

Delete `.specify/ranges.json`; the lint guard then no-ops and numbering reverts
to the prior behaviour. The scripts are additive and harmless if unused.

## 7. Migration Plan (if applicable)

None — no existing spec needs renumbering; all upstream specs already fall inside
the default `1–4999` band.

## 8. Open Questions for Plan

None.
