# Plan: 1683 — 822 services stop swallowing their errors

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-19   |
| Last updated | 2026-08-19   |

## Approach

PR 4 of 5 and the payload of the sequence. Ordered last among the mechanical passes because it
depends on all three predecessors: the reason vocabulary (1680), generators that no longer
reintroduce the shape (1681), and a proven codemod harness (1682).

Reuses that harness verbatim rather than inventing a second one — same precondition/postcondition
gates, same mandatory `--expect`, same byte-level EOL handling.

## Steps

1. **Probe first.** Count the population and its encoding before writing any transform: 822 matches,
   822 of them CRLF, 16 with a BOM. That number had to agree with the census independently.
2. **`canonical-swallow-diagnostics.ts`** — services. Beyond the anchor, four preconditions matter:
   exactly one `jobs` declaration, exactly one `return { jobs };`, the ordering `decl < try < catch`,
   and `jobs.push(` inside the try. The ordering check is what licenses passing `jobs` instead of
   `[]`; without it the codemod could silently drop partial results.
3. **`canonical-swallow-specs.ts`** — specs, gated on the sibling service actually carrying the new
   catch. 809 specs match the anchor but only 806 belong to migrated services.
4. Dry run both, confirm the counts, then apply.

## Testing

The census warning still governs: 1,505 generated specs assert `result.jobs` only and stay green
whatever a plugin reports. Verification is therefore layered, strongest first:

- **Sabotage** — revert one migrated service to the swallow; its spec must fail. It did
  (`Expected: "fetch_error", Received: undefined`). Restored, and the diff distribution re-checked
  afterwards to prove no residue.
- **Diff-shape gate** — 822 services exactly `+7/-1`, 806 specs exactly `+3/0`, zero outliers across
  1,628 files. Any other shape means the transform did something unintended.
- **EOL churn gate** — both diff forms report 1,628.
- **`tsc --noEmit`** — clean.
- **Targeted suites** across migrated packages.

## Rollout

Source-only; no schema, no wire-format change, no new secret. A clean `git revert` restores the
previous behaviour.

Operationally visible: sources that were failing silently will start reporting `blocked`,
`bad_input`, `fetch_error` and friends instead of `empty`, and the Spec 1680 metric labels move with
them. That step change is the fix landing, not a regression — but it should be expected rather than
discovered.
