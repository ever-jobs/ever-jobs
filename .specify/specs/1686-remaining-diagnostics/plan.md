# Plan: 1686 — the last 33, finished by reading them

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-20   |
| Last updated | 2026-08-20   |

## Approach

Spec 1685 stopped where a codemod stopped being safe and labelled the rest "hand review". Correct
about the technique, wrong about the implication — per-file judgement is still this work, not
someone else's. So: read all 33 and finish them.

The split that made it tractable is between *judgement* and *mechanics*. The judgement — where a
variable can legally be declared, which accumulator the terminal return uses, which of several
catches actually decided the outcome — comes from reading the file. Everything mechanical stays
automated, because that is precisely what hand-editing 33 files gets wrong: brace matching, import
insertion, CRLF/BOM preservation, and verifying the assignment landed in scope.

## Steps

1. Enumerate every remaining service and classify by catch shape.
2. Auto-derive plan entries where the accumulator and its declaration are unambiguous — 15 of them.
3. Read the rest. 13 more resolved once the early `return new JobResponseDto([])` guard was
   recognised as a guard rather than the terminal return.
4. Edit the 5 singular ones directly.
5. Census again to prove nothing is left.

## Testing

- **`tsc --noEmit`** — the gate that killed the automatic version in Spec 1685, and the reason to
  trust this one. 0 errors.
- **Applier postconditions** — output parses, exactly one call/declaration, and the assignment is
  re-derived from the output as sitting inside an `err` catch.
- **Census** — 1,827 report a reason, 5 delegate by design, 0 unmigrated.
- **No EOL churn** — both diff forms report 33.
- **Targeted suites** across the hand-edited plugins.

One defect caught mid-flight: the applier's first version indented the assignment to the wrong
column. Cosmetic, but it would have landed in 15 files, so it was fixed and re-verified before
moving on.

## Rollout

Source-only. Guard clauses that previously returned a bare empty result now report `bad_input` or
`empty` with a detail — visible in `per_source`, and strictly more informative.
